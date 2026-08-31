#define _DARWIN_C_SOURCE

#include "process.h"

#include <errno.h>
#include <mach-o/dyld.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/param.h>
#include <sys/wait.h>
#include <unistd.h>

extern char **environ;

static int af_error(char *error, size_t capacity, const char *message) {
  if (error != NULL && capacity > 0) (void)snprintf(error, capacity, "%s", message);
  return -1;
}

int af_sibling_executable(const char *name, char *output, size_t output_capacity, char *error, size_t error_capacity) {
  char raw[MAXPATHLEN];
  char resolved[MAXPATHLEN];
  char *separator;
  uint32_t raw_capacity = (uint32_t)sizeof(raw);
  int written;
  if (
    name == NULL
    || name[0] == '\0'
    || strchr(name, '/') != NULL
    || output == NULL
    || output_capacity == 0
    || _NSGetExecutablePath(raw, &raw_capacity) != 0
    || realpath(raw, resolved) == NULL
  ) return af_error(error, error_capacity, "helper executable path is unavailable");
  separator = strrchr(resolved, '/');
  if (separator == NULL) return af_error(error, error_capacity, "helper executable path is unavailable");
  *separator = '\0';
  written = snprintf(output, output_capacity, "%s/%s", resolved, name);
  if (written < 0 || (size_t)written >= output_capacity || access(output, X_OK) != 0) {
    return af_error(error, error_capacity, "pack sibling executable is unavailable");
  }
  return 0;
}

int af_run_process(const char *executable, char *const argv[], char *error, size_t error_capacity) {
  pid_t child;
  int status;
  int spawned;
  if (executable == NULL || executable[0] != '/' || argv == NULL || argv[0] == NULL) {
    return af_error(error, error_capacity, "invalid engine process request");
  }
  spawned = posix_spawn(&child, executable, NULL, NULL, argv, environ);
  if (spawned != 0) return af_error(error, error_capacity, "engine process could not start");
  while (waitpid(child, &status, 0) < 0) {
    if (errno == EINTR) continue;
    return af_error(error, error_capacity, "engine process wait failed");
  }
  if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) return af_error(error, error_capacity, "engine process failed");
  return 0;
}
