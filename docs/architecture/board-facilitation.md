# Board facilitation and Talktrack

Both live in `backend/apps/canvas` and `src/components/canvas/{facilitation,talktrack}`. They sync through
board data and polling; there is no realtime service.

## Timer, voting and private mode

- State is in `BoardTimer`, `VotingSession`, `VotingVote`, `VotingDone` and `BoardPrivateMode` (migration
  `0009_facilitation`). `GET /api/canvas-boards/<id>/facilitation` returns one snapshot; clients poll it and
  correct their clock with the server's `serverNow`.
- Voting totals are SQL aggregates. Other people's ballots are hidden until the session ends.
- Private mode redacts other people's sticky text on every read path (`private_mode.redact_graph`) and
  restores it on every save (`restore_hidden`).
- Timer music is bundled in `public/timer-music` (license in `LICENSE.md`).
- There is no presentation mode yet. The timer dock is an always-on overlay on the board view, so any
  presentation built on that view shows it.

## Talktrack

- Recording: `talktrack-recorder.js` runs MediaRecorder on the screen or camera, plus a separate low-bitrate
  audio-only recording used for the transcript. Files upload through the `talktrack` purpose in
  `apps/media/uploads.py`, then `POST /talktracks` copies them into `talktrack/<board>/...`.
- Trim is stored as playback offsets and the file is untouched. "Cut out a section" is a `Talktrack` row in
  status `working:cutting`, claimed by the scheduler (`process_talktracks`, ffmpeg). A new webm gets a `-c copy`
  remux so it is seekable. A failed job leaves the original playable.
- Transcript, chapters: only on request (`POST /talktracks/<id>/transcript`), through the existing paid audio
  transcription path and its paid guard. Chapters are derived from the transcript every minute. No summary is
  generated, since that would need an automatic LLM job.
- Analytics: `TalktrackView` keeps each person's furthest point. Reactions and comments are `TalktrackMoment`
  rows. Viewing and listing need view access, reacting needs comment access, editing and viewer reports need
  edit access.
- The app's `Permissions-Policy` allows camera, microphone and display capture for the app's own origin.
