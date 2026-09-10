//! Finding a device again after its address changed.
//!
//! A remembered address covers the ordinary case. What this module exists for
//! is the case after that: a phone whose DHCP lease turned over, which under
//! the old schema was unreachable for good.
//!
//! Deliberately absent: mDNS. Not because of a permission — `NsdManager`
//! carries none for discovery — but because the pairing payload already carries
//! an address and a key, so the only thing left to solve is re-finding a device
//! that has moved, and a tagged sweep solves it in one file with no service
//! record to keep truthful.
//!
//! Also deliberately absent: broadcast. One packet instead of 254 would be
//! nicer, but reliable reception of broadcast and multicast on Wi-Fi wants a
//! `MulticastLock`, which wants `CHANGE_WIFI_MULTICAST_STATE` and a Kotlin
//! plugin to hold it. Unicast needs neither, and the sweep already works.

use std::net::{IpAddr, Ipv4Addr, SocketAddr, UdpSocket};
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};

/// The one port that has to be agreed in advance.
///
/// The TCP port is whatever `bind` gives and is announced in the reply, so this
/// is the whole of the fixed configuration in the design.
pub const RENDEZVOUS: u16 = 47810;

/// How wide a subnet this will sweep.
///
/// A /24 is 254 unicast datagrams of about 48 bytes — some 12 KB, which is
/// nothing. A /16 is 65,000 packets, which is a flood, so it is declined with a
/// sentence instead. The honest message for a network that will not carry this
/// is that the two devices are on a network that will not let them talk, not
/// that the other device was not found.
const NARROWEST_SWEEPABLE: u8 = 24;

/// A probe names nobody in clear.
///
/// The tag is a hash over a fresh nonce and the peer's own static public key,
/// so only a device holding that key recognises it. An unpaired listener on the
/// same Wi-Fi learns nothing at all from being swept — not who is looking, not
/// who is being looked for.
fn tag(domain: &[u8], nonce: &[u8], pk: &[u8]) -> [u8; 16] {
    let d = Sha256::new()
        .chain_update(domain)
        .chain_update(nonce)
        .chain_update(pk)
        .finalize();
    let mut out = [0u8; 16];
    out.copy_from_slice(&d[..16]);
    out
}

const PROBE: &[u8] = b"trackit-probe-v1";
const REPLY: &[u8] = b"trackit-probe-reply-v1";

/// Every non-loopback IPv4 this device has, with its netmask.
///
/// All of them, not a guess. A Mac with Wi-Fi plus a VPN or a Docker bridge has
/// several, and picking one is picking wrong roughly half the time.
pub fn own_interfaces() -> Result<Vec<(Ipv4Addr, Ipv4Addr)>, String> {
    let mut out = Vec::new();
    for iface in if_addrs::get_if_addrs().map_err(|e| format!("reading this device's addresses: {e}"))? {
        if iface.is_loopback() {
            continue;
        }
        if let if_addrs::IfAddr::V4(v4) = iface.addr {
            out.push((v4.ip, v4.netmask));
        }
    }
    Ok(out)
}

/// Whether an address is one a home or office network hands out.
///
/// The three RFC 1918 ranges. Not a security check — an address being private
/// proves nothing about who can reach it — but a plausibility one, which is
/// what the ordering below needs.
fn is_private(ip: Ipv4Addr) -> bool {
    let o = ip.octets();
    o[0] == 10 || (o[0] == 172 && (16..32).contains(&o[1])) || (o[0] == 192 && o[1] == 168)
}

/// The plausible addresses out of a list, best first.
///
/// The order is the whole point, because the caller keeps only the first two —
/// the code gets too dense to photograph past about 145 bytes. A phone with
/// mobile data up has a `rmnet` address alongside its Wi-Fi one and
/// `getifaddrs` returns them in whatever order the kernel holds them, so an
/// unsorted list could print a carrier address the other device cannot reach
/// and drop the Wi-Fi address that it can. RFC 1918 addresses therefore come
/// first, and a 169.254 link-local — which is what an interface with no lease
/// gives itself — is dropped outright rather than merely ranked last: it is
/// never an address a second device can dial.
///
/// Split out from the call that reads the real interfaces so that it can be
/// tested. Whether this machine currently has a VPN up is not something a test
/// can arrange, and it is not what the ranking rule needs proving about.
pub fn rank_addresses(ips: Vec<Ipv4Addr>) -> Vec<Ipv4Addr> {
    let mut ips: Vec<Ipv4Addr> = ips.into_iter().filter(|ip| !ip.is_link_local()).collect();
    // A stable sort, so two addresses of the same standing stay in the order the
    // system reported them rather than in one this function invented.
    ips.sort_by_key(|ip| u8::from(!is_private(*ip)));
    ips
}

/// Every plausible IPv4 this device has, best first, for the pairing payload.
pub fn own_addresses() -> Result<Vec<Ipv4Addr>, String> {
    Ok(rank_addresses(
        own_interfaces()?.into_iter().map(|(ip, _)| ip).collect(),
    ))
}

/// How many leading ones a netmask has.
pub fn prefix_len(mask: Ipv4Addr) -> u8 {
    u32::from_be_bytes(mask.octets()).count_ones() as u8
}

/// Every host address in one interface's subnet, excluding the network and
/// broadcast addresses and this device itself.
pub fn hosts_of(ip: Ipv4Addr, mask: Ipv4Addr) -> Vec<Ipv4Addr> {
    let m = u32::from_be_bytes(mask.octets());
    let a = u32::from_be_bytes(ip.octets());
    let net = a & m;
    let bcast = net | !m;
    let mut out = Vec::new();
    let mut h = net.wrapping_add(1);
    while h < bcast {
        if h != a {
            out.push(Ipv4Addr::from(h.to_be_bytes()));
        }
        h = h.wrapping_add(1);
    }
    out
}

/// Answer one probe, if one has arrived and it is tagged with a key this
/// household holds.
///
/// `tcp_port` is where this device answers a sync, and it is announced in the
/// reply rather than agreed in advance — so only the UDP port above is fixed
/// configuration.
///
/// `keys` is a closure and not a slice on purpose. The caller's list comes out
/// of the database, and the loop around this function wakes on a read timeout
/// twice a second for the life of the process; reading `peers` on every one of
/// those wake-ups would take the one connection's lock twice a second for ever,
/// against the interface, to answer a question nobody asked. It is called only
/// when a datagram has actually turned up.
pub fn answer_probes(
    sock: &UdpSocket,
    tcp_port: u16,
    keys: impl FnOnce() -> Vec<Vec<u8>>,
) -> Result<(), String> {
    let mut buf = [0u8; 64];
    let (n, from) = match sock.recv_from(&mut buf) {
        Ok(v) => v,
        // A read timeout is how the loop above gets its chance to notice it
        // should stop. It is not news.
        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => return Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::TimedOut => return Ok(()),
        Err(e) => return Err(e.to_string()),
    };
    if n != 32 {
        return Ok(());
    }
    let (nonce, seen) = buf[..32].split_at(16);
    for pk in keys() {
        if tag(PROBE, nonce, &pk) != seen {
            continue;
        }
        let mut out = Vec::with_capacity(18);
        out.extend_from_slice(&tag(REPLY, nonce, &pk));
        out.extend_from_slice(&tcp_port.to_be_bytes());
        let _ = sock.send_to(&out, from);
        return Ok(());
    }
    Ok(())
}

/// Probe a list of addresses and return where the holder of `static_pk`
/// answered from, if anywhere.
///
/// Every probe goes out first and only then is the reply waited for. One send
/// and one wait per host would multiply the timeout by 254; a whole subnet's
/// worth of datagrams is about 12 KB and goes out in a few milliseconds.
pub fn sweep(
    targets: &[SocketAddr],
    static_pk: &[u8],
    budget: Duration,
) -> Result<Option<SocketAddr>, String> {
    let sock = UdpSocket::bind("0.0.0.0:0")
        .map_err(|e| format!("opening a socket to look for that device: {e}"))?;
    sock.set_read_timeout(Some(Duration::from_millis(150)))
        .map_err(|e| e.to_string())?;

    let mut nonce = [0u8; 16];
    getrandom::fill(&mut nonce).map_err(|e| format!("getting a fresh probe: {e}"))?;
    let mut probe = Vec::with_capacity(32);
    probe.extend_from_slice(&nonce);
    probe.extend_from_slice(&tag(PROBE, &nonce, static_pk));
    let want = tag(REPLY, &nonce, static_pk);

    let started = Instant::now();
    for at in targets {
        if started.elapsed() > budget {
            break;
        }
        let _ = sock.send_to(&probe, at);
    }
    while started.elapsed() <= budget {
        let mut buf = [0u8; 64];
        match sock.recv_from(&mut buf) {
            Ok((18, from)) if buf[..16] == want => {
                let port = u16::from_be_bytes([buf[16], buf[17]]);
                if port == 0 {
                    continue;
                }
                return Ok(Some(SocketAddr::new(from.ip(), port)));
            }
            // Somebody else's traffic on a shared port, or a reply to a probe
            // that is not this one. Neither is news.
            Ok(_) => continue,
            Err(_) => continue,
        }
    }
    Ok(None)
}

/// Find one peer on this network, or say honestly that it is not answering.
///
/// One unicast datagram to every host in each of our own subnets, and the first
/// tagged reply wins. The remembered address is tried by the caller before this
/// is reached, because it is one packet and covers every ordinary case.
pub fn find(static_pk: &[u8], budget: Duration) -> Result<Option<SocketAddr>, String> {
    let mut targets = Vec::new();
    let mut too_wide = false;
    for (ip, mask) in own_interfaces()? {
        if prefix_len(mask) < NARROWEST_SWEEPABLE {
            too_wide = true;
            continue;
        }
        targets.extend(
            hosts_of(ip, mask)
                .into_iter()
                .map(|h| SocketAddr::new(IpAddr::V4(h), RENDEZVOUS)),
        );
    }
    if let Some(at) = sweep(&targets, static_pk, budget)? {
        return Ok(Some(at));
    }
    if too_wide {
        return Err("that device is not at the address it was last reached at, and this network \
                    is too large to look across — they are on a network that will not let these \
                    two find each other"
            .into());
    }
    Ok(None)
}
