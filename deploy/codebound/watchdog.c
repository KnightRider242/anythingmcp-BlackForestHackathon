/* SPDX-License-Identifier: AGPL-3.0-only */
/* Linux namespace PID 1: reaps children and cannot be SIGSTOP'd by script code. */
#include <errno.h>
#include <signal.h>
#include <stdlib.h>
#include <sys/prctl.h>
#include <sys/wait.h>
#include <unistd.h>

static void expire(int signal_number) {
  (void)signal_number;
  /* Exiting namespace PID 1 makes the kernel terminate the remaining tasks. */
  _exit(124);
}

int main(void) {
  if (getpid() != 1 || getuid() != 65534) return 125;
  /* Same-UID children must not be able to write the watchdog's /proc memory. */
  if (prctl(PR_SET_DUMPABLE, 0) != 0) return 125;
  struct sigaction action = {0};
  action.sa_handler = expire;
  sigemptyset(&action.sa_mask);
  if (sigaction(SIGALRM, &action, NULL) != 0) return 125;
  alarm(35);
  pid_t script = fork();
  if (script < 0) return 125;
  if (script == 0) {
    execlp("node", "node", "/sandbox/runner.cjs", (char *)NULL);
    _exit(125);
  }
  for (;;) {
    int status;
    pid_t reaped = waitpid(-1, &status, 0);
    if (reaped < 0) {
      if (errno == EINTR) continue;
      return 125;
    }
    if (reaped == script) {
      if (WIFEXITED(status)) return WEXITSTATUS(status);
      if (WIFSIGNALED(status)) return 128 + WTERMSIG(status);
      return 125;
    }
  }
}
