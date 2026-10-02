# Exercise drawings made for TrackIt

Everkinetic's set has nothing a lifter would recognise as a face pull, a kettlebell swing or a
forearm plank, so these three were drawn for TrackIt (decisions.md, D27). They are drawn to sit
beside Greg Priday's drawings in `../everkinetic/`: the same line weight, proportions and scale.
They are not traced from, adapted from or copied from his drawings, so they carry neither his name
nor his licence, and his licence does not reach this folder.

| Lift | Files |
|---|---|
| Face pull | `face-pull-start.svg`, `face-pull-halfway.svg` |
| Kettlebell swing | `kettlebell-swing-start.svg`, `kettlebell-swing-halfway.svg` |
| Plank | `plank-held.svg` (a hold, so one frame) |

They are generated, not hand-edited: `tools/figures/draw.py` poses a drawn figure from joint angles
and writes these files. To change one, change the code and run `python3 tools/figures/draw.py`;
`python3 tools/figures/draw.py --check` confirms the files here are exactly what the code makes.

Each file follows the same rules as the Everkinetic files, and `src/lib/exerciseArt.test.ts`
checks them:
- ink only: `fill="currentColor"` paths, with no strokes, white, masks or images, because the app
  uses each file as a CSS mask over its own ink colour;
- a viewBox and no fixed size;
- one canvas shared by both frames of a lift, with the feet in the same place, so the two frames
  line up.
