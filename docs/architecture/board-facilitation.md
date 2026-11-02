# Board facilitation and Talktrack

Both live in `backend/apps/canvas` and `src/components/canvas/{facilitation,talktrack}`. They sync through
board data and polling; there is no realtime service.

## Timer, voting and private mode

- State is in `BoardTimer`, `VotingSession`, `VotingVote`, `VotingDone` and `BoardPrivateMode` (migration
  `0015_facilitation`). `GET /api/canvas-boards/<id>/facilitation` returns one snapshot; clients poll it and
  correct their clock with the server's `serverNow`.
- Voting totals are SQL aggregates. Other people's ballots are hidden until the session ends.
- Private mode redacts other people's sticky text on every read path (`private_mode.redact_graph`) and
  restores it on every save (`restore_hidden`). In anonymous mode each attribution on a note (author, editor,
  text writer, private owner) is shown only to the person it names, on reads and in save replies, and its
  History rows record no actor.
- Timer music is bundled in `public/timer-music` (license in `LICENSE.md`).
- There is no presentation mode yet. The timer dock is an always-on overlay on the board view, so any
  presentation built on that view shows it.

## Talktrack

- Recording: `talktrack-recorder.js` runs MediaRecorder on the screen or camera, plus a separate low-bitrate
  audio-only recording used for the transcript. Files upload through the `talktrack` purpose in
  `apps/media/uploads.py`, then `POST /talktracks` copies them into `talktrack/<board>/...`.
- Trim is stored as playback offsets and the file is untouched. "Cut out a section" is a `Talktrack` row in
  status `working:cutting`, claimed by the scheduler in one background thread, one job at a time
  (`talktrack.process_jobs`, ffmpeg), so its other handlers never wait on an encode. The cut is applied to the
  audio twin too, and moves reactions, comments and view progress with the timeline. A new webm gets a
  `-c copy` remux so it is seekable. A job writes back only if its row is still the one it claimed, and the
  replaced files are deleted. A failed job leaves the original playable.
- Registering deletes the staged uploads. Deleting a board deletes its recordings, views, moments and files.
- Transcript, chapters: only on request (`POST /talktracks/<id>/transcript`), through the existing paid audio
  transcription path and its paid guard; the gateway treats it as a paid initial route (`BOARD_TRANSCRIPTIONS`,
  `../features/board-media.md`). It is refused while a remux or cut is pending, and kept only if the
  audio it read is still the recording's. Chapters are derived from the transcript every minute. No summary is
  generated, since that would need an automatic LLM job.
- Every timeline offset a client sends (view progress, reactions and comments, trim, cut) carries the
  `durationMs` of the file it was measured on; one measured before a cut landed is refused with 409.
- Analytics: `TalktrackView` keeps each person's furthest point. Reactions and comments are `TalktrackMoment`
  rows. Viewing and listing need view access, reacting needs comment access, editing and viewer reports need
  edit access.
- The app's `Permissions-Policy` allows camera, microphone and display capture for the app's own origin.
