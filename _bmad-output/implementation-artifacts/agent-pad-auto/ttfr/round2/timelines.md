# Round 2 timelines (memo A parked, memo B driving)

Clock: host/UTC. Device logcat shifted by +0.720 s (device = host - 720 ms, 5 adb samples, before the emulator crash). Audible = first speaker-tap packet above rms 30.

### Memo A, parked (tap) (memo 7d33527d)

| step | clock (UTC) | since Stop & Send | since agent done | note |
|---|---|---|---|---|
| Stop & Send pressed (adb input) | 22:46:33.414 | +0.00 s |  |  |
| mic closed (queue: mic idle) | 22:46:33.580 | +0.17 s |  |  |
| ack started (queue) | 22:46:33.581 | +0.17 s |  | STOP tone + "Got it, <agent>'s on it." |
| ack AUDIBLE (speaker tap) | 22:46:33.851 | +0.44 s |  |  |
| upload fact | 22:46:34.788 | +1.37 s |  |  |
| transcribed | 22:46:44.430 | +11.02 s |  |  |
| heard echo started (queue) | 22:46:48.472 | +15.06 s |  |  |
| heard echo AUDIBLE | 22:46:49.140 | +15.73 s |  |  |
| agent turn started | 22:46:44.704 | +11.29 s |  |  |
| agent progress#1 | 22:46:57.309 | +23.89 s |  |  |
| progress on the car | - | - | - | none offered (turn too short to narrate) |
| agent DONE (invocation.completed) | 22:47:04.080 | +30.67 s | +0.0 s |  |
| reply chunk 1 up | 22:47:15.465 | +42.05 s | +11.4 s |  |
| full reply up (replied fact) | 22:47:33.942 | +60.53 s | +29.9 s |  |
| reply started (queue) | 22:47:17.021 | +43.61 s | +12.9 s | waited_ms=2 |
| reply AUDIBLE | 22:47:17.694 | +44.28 s | +13.6 s |  |
| reply ended (queue) | 22:47:35.198 | +61.78 s | +31.1 s | end chunks=3 |
| reply last sound (tap) | 22:47:34.998 | +61.58 s | +30.9 s |  |

### Memo B, driving (wheel playpause) (memo e2928012)

| step | clock (UTC) | since Stop & Send | since agent done | note |
|---|---|---|---|---|
| Stop & Send pressed (adb input) | 22:49:32.975 | +0.00 s |  |  |
| mic closed (queue: mic idle) | 22:49:33.114 | +0.14 s |  |  |
| ack started (queue) | 22:49:33.114 | +0.14 s |  | STOP tone + "Got it, <agent>'s on it." |
| ack AUDIBLE (speaker tap) | 22:49:33.358 | +0.38 s |  |  |
| upload fact | 22:49:33.295 | +0.32 s |  |  |
| transcribed | 22:49:39.040 | +6.06 s |  |  |
| heard echo started (queue) | 22:49:39.621 | +6.65 s |  |  |
| heard echo AUDIBLE | 22:49:40.248 | +7.27 s |  |  |
| agent turn started | 22:49:39.369 | +6.39 s |  |  |
| agent progress#1 | 22:49:52.641 | +19.67 s |  |  |
| progress on the car | - | - | - | none offered (turn too short to narrate) |
| agent DONE (invocation.completed) | 22:49:56.749 | +23.77 s | +0.0 s |  |
| reply chunk 1 up | 22:50:03.720 | +30.74 s | +7.0 s |  |
| full reply up (replied fact) | 22:50:11.010 | +38.03 s | +14.3 s |  |
| reply started (queue) | 22:50:04.021 | +31.05 s | +7.3 s | waited_ms=2 |
| reply AUDIBLE | 22:50:04.787 | +31.81 s | +8.0 s |  |
| reply ended (queue) | 22:50:21.863 | +48.89 s | +25.1 s | end chunks=2 |
| reply last sound (tap) | 22:50:21.923 | +48.95 s | +25.2 s |  |

### Speaker segments after Stop & Send (s since the press; tone = STOP earcon, then the spoken ack, then the SENT tone)

```
A:
+0.437 .. +0.703 s  ( 266 ms, peak rms 657)
+1.049 .. +1.423 s  ( 374 ms, peak rms 453)
+1.751 .. +2.657 s  ( 906 ms, peak rms 564)
+3.125 .. +3.450 s  ( 325 ms, peak rms 659)
B:
+0.382 .. +0.650 s  ( 268 ms, peak rms 658)
+1.043 .. +1.399 s  ( 356 ms, peak rms 464)
+1.727 .. +2.633 s  ( 906 ms, peak rms 554)
+3.121 .. +3.415 s  ( 294 ms, peak rms 657)
X (torture, after the cold boot; offset -88 ms):
+0.383 .. +0.639 s  ( 256 ms, peak rms 661)
+1.006 .. +1.367 s  ( 362 ms, peak rms 456)
+1.715 .. +2.591 s  ( 876 ms, peak rms 566)
+3.059 .. +3.353 s  ( 294 ms, peak rms 657)
Y (stopped while X's deferred progress clip waited: no STOP tone, the first sound is X's progress clip):
+0.932 .. +1.890 s  ( 958 ms, peak rms 322)
+2.234 .. +2.489 s  ( 255 ms, peak rms 311)
+2.629 .. +3.005 s  ( 376 ms, peak rms 241)
```

## Torture memos (after the emulator cold boot; device = host - 88 ms)

### Memo X (memo 868a91aa)

| step | clock (UTC) | since Stop & Send | since agent done | note |
|---|---|---|---|---|
| Stop & Send pressed (adb input) | 23:26:29.661 | +0.00 s |  |  |
| mic closed (queue: mic idle) | 23:26:29.769 | +0.11 s |  |  |
| ack started (queue) | 23:26:29.769 | +0.11 s |  | STOP tone + "Got it, <agent>'s on it." |
| ack AUDIBLE (speaker tap) | 23:26:30.044 | +0.38 s |  |  |
| upload fact | 23:26:29.940 | +0.28 s |  |  |
| transcribed | 23:26:36.514 | +6.85 s |  |  |
| heard echo started (queue) | 23:26:37.371 | +7.71 s |  |  |
| heard echo AUDIBLE | 23:26:38.049 | +8.39 s |  |  |
| agent turn started | 23:26:36.761 | +7.10 s |  |  |
| agent progress#1 | 23:26:46.724 | +17.06 s |  |  |
| progress clip up narrated#1 | 23:26:56.147 | +26.49 s |  |  |
| first progress started (queue) | 23:27:11.589 | +41.93 s |  |  |
| first progress AUDIBLE | 23:27:12.360 | +42.70 s |  |  |
| agent DONE (invocation.completed) | 23:27:31.950 | +62.29 s | +0.0 s |  |
| reply chunk 1 up | 23:27:40.380 | +70.72 s | +8.4 s |  |
| full reply up (replied fact) | 23:27:56.142 | +86.48 s | +24.2 s |  |
| reply started (queue) | 23:27:45.638 | +75.98 s | +13.7 s | waited_ms=5074 |
| reply AUDIBLE | 23:27:46.193 | +76.53 s | +14.2 s |  |
| reply ended (queue) | 23:28:13.576 | +103.91 s | +41.6 s | end chunks=3 |
| reply last sound (tap) | 23:28:13.616 | +103.96 s | +41.7 s |  |

### Memo Y (memo 94127309)

| step | clock (UTC) | since Stop & Send | since agent done | note |
|---|---|---|---|---|
| Stop & Send pressed (adb input) | 23:27:11.428 | +0.00 s |  |  |
| mic closed (queue: mic idle) | 23:27:11.588 | +0.16 s |  |  |
| ack started (queue) | 23:29:27.899 | +136.47 s | +98.5 s | STOP tone + "Got it, <agent>'s on it." |
| ack AUDIBLE (speaker tap) | 23:29:28.161 | +136.73 s | +98.8 s |  |
| upload fact | 23:27:11.967 | +0.54 s |  |  |
| transcribed | 23:27:18.869 | +7.44 s |  |  |
| heard echo started (queue) | 23:27:19.740 | +8.31 s |  |  |
| heard echo AUDIBLE | 23:27:20.494 | +9.07 s |  |  |
| agent turn started | 23:27:19.193 | +7.76 s |  |  |
| agent progress#1 | 23:27:26.825 | +15.40 s |  |  |
| progress clip up narrated#1 | 23:27:40.286 | +28.86 s |  |  |
| first progress started (queue) | 23:27:40.445 | +29.02 s |  |  |
| first progress AUDIBLE | 23:27:40.871 | +29.44 s |  |  |
| agent DONE (invocation.completed) | 23:27:49.380 | +37.95 s | +0.0 s |  |
| reply chunk 1 up | - | - | - |  |
| full reply up (replied fact) | 23:27:55.370 | +43.94 s | +6.0 s |  |
| reply started (queue) | 23:28:13.682 | +62.25 s | +24.3 s | waited_ms=0 |
| reply AUDIBLE | 23:28:14.145 | +62.72 s | +24.8 s |  |
| reply ended (queue) | 23:28:18.592 | +67.16 s | +29.2 s | end  |
| reply last sound (tap) | 23:28:18.537 | +67.11 s | +29.2 s |  |

### Memo R (memo bd75bd2d)

| step | clock (UTC) | since Stop & Send | since agent done | note |
|---|---|---|---|---|
| Stop & Send pressed (adb input) | 23:29:27.834 | +0.00 s |  |  |
| mic closed (queue: mic idle) | 23:29:27.898 | +0.06 s |  |  |
| ack started (queue) | 23:29:27.899 | +0.06 s |  | STOP tone + "Got it, <agent>'s on it." |
| ack AUDIBLE (speaker tap) | 23:29:28.161 | +0.33 s |  |  |
| upload fact | 23:29:28.042 | +0.21 s |  |  |
| transcribed | 23:29:34.284 | +6.45 s |  |  |
| heard echo started (queue) | 23:29:35.208 | +7.37 s |  |  |
| heard echo AUDIBLE | 23:29:36.004 | +8.17 s |  |  |
| agent turn started | 23:29:34.547 | +6.71 s |  |  |
| progress on the car | - | - | - | none offered (turn too short to narrate) |
| agent DONE (invocation.completed) | 23:29:43.222 | +15.39 s | +0.0 s |  |
| reply chunk 1 up | 23:29:47.088 | +19.25 s | +3.9 s |  |
| full reply up (replied fact) | 23:30:00.016 | +32.18 s | +16.8 s |  |
| reply started (queue) | 23:29:52.346 | +24.51 s | +9.1 s | waited_ms=2407 |
| reply AUDIBLE | 23:29:52.840 | +25.01 s | +9.6 s |  |
| reply ended (queue) | 23:30:15.110 | +47.28 s | +31.9 s | end chunks=3 |
| reply last sound (tap) | 23:30:15.048 | +47.21 s | +31.8 s |  |

### Memo P (memo fc42f9ac)

| step | clock (UTC) | since Stop & Send | since agent done | note |
|---|---|---|---|---|
| Stop & Send pressed (adb input) | 23:29:49.548 | +0.00 s |  |  |
| mic closed (queue: mic idle) | 23:29:49.724 | +0.18 s |  |  |
| ack started (queue) | 23:29:49.724 | +0.18 s |  | STOP tone + "Got it, <agent>'s on it." |
| ack AUDIBLE (speaker tap) | 23:29:50.034 | +0.49 s |  |  |
| upload fact | 23:29:49.993 | +0.44 s |  |  |
| transcribed | 23:29:58.615 | +9.07 s |  |  |
| heard echo started (queue) | 23:30:15.121 | +25.57 s |  |  |
| heard echo AUDIBLE | 23:30:15.863 | +26.31 s |  |  |
| agent turn started | 23:29:58.913 | +9.36 s |  |  |
| agent progress#1 | 23:30:07.933 | +18.38 s |  |  |
| progress clip up narrated#1 | 23:30:17.495 | +27.95 s |  |  |
| first progress started (queue) | 23:30:19.200 | +29.65 s |  |  |
| first progress AUDIBLE | 23:30:19.644 | +30.10 s |  |  |
| agent DONE (invocation.completed) | 23:30:40.505 | +50.96 s | +0.0 s |  |
| reply chunk 1 up | - | - | - |  |
| full reply up (replied fact) | 23:30:44.082 | +54.53 s | +3.6 s |  |
| reply started (queue) | 23:30:44.290 | +54.74 s | +3.8 s | waited_ms=2 |
| reply AUDIBLE | 23:30:44.750 | +55.20 s | +4.2 s |  |
| reply ended (queue) | 23:30:48.410 | +58.86 s | +7.9 s | end  |
| reply last sound (tap) | 23:30:48.391 | +58.84 s | +7.9 s |  |

### Memo S (memo d23a5e96)

| step | clock (UTC) | since Stop & Send | since agent done | note |
|---|---|---|---|---|
| Stop & Send pressed (adb input) | 23:31:20.126 | +0.00 s |  |  |
| mic closed (queue: mic idle) | 23:31:20.322 | +0.20 s |  |  |
| ack started (queue) | 23:31:20.323 | +0.20 s |  | STOP tone + "Got it, <agent>'s on it." |
| ack AUDIBLE (speaker tap) | 23:31:20.601 | +0.48 s |  |  |
| upload fact | 23:31:20.664 | +0.54 s |  |  |
| transcribed | 23:31:26.951 | +6.82 s |  |  |
| heard echo started (queue) | 23:31:27.803 | +7.68 s |  |  |
| heard echo AUDIBLE | 23:31:28.440 | +8.31 s |  |  |
| agent turn started | 23:31:27.195 | +7.07 s |  |  |
| progress on the car | - | - | - | none offered (turn too short to narrate) |
| agent DONE (invocation.completed) | 23:31:38.636 | +18.51 s | +0.0 s |  |
| reply chunk 1 up | 23:31:43.325 | +23.20 s | +4.7 s |  |
| full reply up (replied fact) | 23:31:59.362 | +39.24 s | +20.7 s |  |
| reply started (queue) | 23:31:44.779 | +24.65 s | +6.1 s | waited_ms=1204 |
| reply AUDIBLE | 23:31:46.052 | +25.93 s | +7.4 s |  |
| reply ended (queue) | 23:32:11.810 | +51.68 s | +33.2 s | end chunks=4 |
| reply last sound (tap) | 23:32:11.756 | +51.63 s | +33.1 s |  |

### Memo Q (memo dafbd8b6)

| step | clock (UTC) | since Stop & Send | since agent done | note |
|---|---|---|---|---|
| Stop & Send pressed (adb input) | 23:31:41.925 | +0.00 s |  |  |
| mic closed (queue: mic idle) | 23:31:42.060 | +0.13 s |  |  |
| ack started (queue) | 23:31:42.060 | +0.13 s |  | STOP tone + "Got it, <agent>'s on it." |
| ack AUDIBLE (speaker tap) | 23:31:42.334 | +0.41 s |  |  |
| upload fact | 23:31:42.249 | +0.32 s |  |  |
| transcribed | 23:31:51.090 | +9.16 s |  |  |
| heard echo started (queue) | 23:32:11.821 | +29.90 s |  |  |
| heard echo AUDIBLE | 23:32:12.606 | +30.68 s |  |  |
| agent turn started | 23:31:51.377 | +9.45 s |  |  |
| agent progress#1 | 23:31:58.752 | +16.83 s |  |  |
| progress clip up narrated#1 | 23:32:10.473 | +28.55 s |  |  |
| first progress started (queue) | 23:32:15.877 | +33.95 s |  |  |
| first progress AUDIBLE | 23:32:16.378 | +34.45 s |  |  |
| agent DONE (invocation.completed) | 23:32:31.289 | +49.36 s | +0.0 s |  |
| reply chunk 1 up | - | - | - |  |
| full reply up (replied fact) | 23:32:35.381 | +53.46 s | +4.1 s |  |
| reply started (queue) | 23:32:35.578 | +53.65 s | +4.3 s | waited_ms=2 |
| reply AUDIBLE | 23:32:36.083 | +54.16 s | +4.8 s |  |
| reply ended (queue) | 23:32:40.352 | +58.43 s | +9.1 s | end  |
| reply last sound (tap) | 23:32:40.303 | +58.38 s | +9.0 s |  |

