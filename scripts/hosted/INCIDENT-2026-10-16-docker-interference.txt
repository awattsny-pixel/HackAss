# Local incident, 2026-10-16: concurrent Docker runs contaminated a SIGTERM loop (no hosted system involved)

While the SIGTERM-during-preflight loop for the container-cleanup fix was measured on the local Supabase stack, a second local session ran the full `scripts/hosted/selftest.mjs` (pid 27495) and its shell command ran `docker rm -f` on every `hackass-psql-*` container.

Effects, all local:
* The reference loop counts every `hackass-psql-*` container (`--filter name=hackass-psql-`) and removes what it finds, so it counted the other run's containers as leftovers (names carried another process id, sequence numbers that the loop's own process never reached) and removed some of them. The other run's selftest may have been disturbed in turn.
* The first fixed-code measurement therefore showed 6 of 24 leftovers although the interrupt handler's own trace showed every in-flight container proved gone. The result was discarded.
* The selftest checks `no hackass-psql container survives` and `no psql client container is left after the whole run` are global by name prefix; they cannot tell another run's container from a leftover.

Resolution: the sessions agreed that Docker is used by one session at a time. The loop was rerun with a variant that counts only `hackass-psql-<pid of its own preflight>-*` and removes nothing it did not start (0 of 30 left over after the fix; 4 of 20 on the old code with the same variant). The full selftest was then run alone (all passed, including both checks above). Nothing in the repository removes containers other than the named ones a process started itself.
