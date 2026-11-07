# Frozen synthetic render

A public eight-by-sixteen rectangle was built and rendered on the ordinary Nova
pool with @rig-c/core 3.4.1. The npm lock declares core 3.4.1 and parts 2.23.4.
Parts was installed and did not produce the rectangle rig. Registration declares
the toolchain association. It does not attest a producer run stamp.

The rig, motion and PNG are synthetic inputs. The build, build report and idle
directory are the producer bytes from the commands below. No renderer runs in
the local registration tests. They consume the frozen bytes. The dated record is
an explicitly cited completion event written after the render.

```sh
rigc build --rig rig/rig.json --motion rig/motion.json --out build --copy-images --report compile-report.json
rigc render --candidate build --animation idle --fps 4 --geometry --viewport "-8,0,16,20" --max 32 --out idle
```

The render declares no skin or preroll because the synthetic rig has no physics.
Its pinned viewport clips a small edge on the second frame, recorded by the
producer in frames.json. The fixture tests registration and byte identity.
It makes no visual acceptance claim.
