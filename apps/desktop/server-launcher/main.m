#import <AppKit/AppKit.h>
#include <crt_externs.h>
#include <errno.h>
#include <spawn.h>
#include <stdio.h>
#include <string.h>
#include <sys/wait.h>

int main(int argc, char *argv[]) {
    if (argc != 2) {
        fprintf(stderr, "Usage: revv-server <bun executable>\n");
        return 2;
    }

    @autoreleasepool {
        // Give SSH agents an application identity without opening a window or Dock icon.
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];

        // Keep Revv as Bun's parent and inherit launchd's process group, cwd, env and IO.
        char *args[] = {argv[1], "run", "apps/server/src/index.ts", NULL};
        pid_t child;
        int error = posix_spawn(&child, argv[1], NULL, NULL, args, *_NSGetEnviron());
        if (error != 0) {
            fprintf(stderr, "Could not start Revv server: %s\n", strerror(error));
            return 1;
        }

        int status;
        while (waitpid(child, &status, 0) == -1) {
            if (errno != EINTR) {
                perror("Could not wait for Revv server");
                return 1;
            }
        }
        return WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
    }
}
