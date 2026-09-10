# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# If your project uses WebView with JS, uncomment the following
# and specify the fully qualified class name to the JavaScript interface
# class:
#-keepclassmembers class fqcn.of.javascript.interface.for.webview {
#   public *;
#}

# Uncomment this to preserve the line number information for
# debugging stack traces.
#-keepattributes SourceFile,LineNumberTable

# If you keep the line number information, uncomment this to
# hide the original source file name.
#-renamesourcefileattribute SourceFile

# The keystore bridge, kept explicitly rather than on trust.
#
# Release builds set isMinifyEnabled = true, and tauri's own consumer rules do
# already keep @TauriPlugin classes and their @Command methods, and @InvokeArg
# classes wholesale. These two lines say the same thing about the classes THIS
# app added, so the bridge does not depend on a dependency's keep rules
# continuing to be written the way they are written today. R8 finds both
# classes by reflection: the plugin by the name Rust registers it under, the
# argument class by field. A renamed field there is a key that silently fails
# to cross, on the one build users actually install.
#
# Every value these commands RETURN travels as a map with literal string keys,
# so no result class needs keeping — see the comment in BackupPlugin.kt.
-keep class com.kgundu1.trackit.BackupPlugin { *; }
-keep class com.kgundu1.trackit.BackupKeyArgs { *; }
