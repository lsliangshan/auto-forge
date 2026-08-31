#define _DARWIN_C_SOURCE

#include "process.h"

#include <mach-o/dyld.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/param.h>
#include <sys/stat.h>
#include <unistd.h>

static int pack_root(char *output, size_t capacity) {
  char raw[MAXPATHLEN];
  char resolved[MAXPATHLEN];
  char *separator;
  uint32_t raw_capacity = (uint32_t)sizeof(raw);
  size_t length;
  if (_NSGetExecutablePath(raw, &raw_capacity) != 0 || realpath(raw, resolved) == NULL) return -1;
  separator = strrchr(resolved, '/');
  if (separator == NULL) return -1;
  *separator = '\0';
  separator = strrchr(resolved, '/');
  if (separator == NULL) return -1;
  *separator = '\0';
  length = strlen(resolved);
  if (length + 1 > capacity) return -1;
  (void)memcpy(output, resolved, length + 1);
  return 0;
}

static int regular_file(const char *path) {
  struct stat metadata;
  char resolved[MAXPATHLEN];
  return lstat(path, &metadata) == 0
    && S_ISREG(metadata.st_mode)
    && realpath(path, resolved) != NULL
    && strcmp(path, resolved) == 0;
}

int main(int argc, char *argv[]) {
  char root[MAXPATHLEN];
  char image[MAXPATHLEN];
  char mount_template[] = "/private/tmp/autoforge-soffice.XXXXXX";
  char engine[MAXPATHLEN];
  char error[256] = {0};
  char **engine_argv;
  char *attach_argv[8];
  char *detach_argv[4];
  int engine_status;
  int detach_status;
  int index;
  if (argc < 2 || argc > 256 || pack_root(root, sizeof(root)) != 0) {
    (void)fprintf(stderr, "invalid LibreOffice launcher request\n");
    return 2;
  }
  if (
    snprintf(image, sizeof(image), "%s/share/LibreOffice.dmg", root) >= (int)sizeof(image)
    || !regular_file(image)
    || mkdtemp(mount_template) == NULL
  ) {
    (void)fprintf(stderr, "pack LibreOffice image is unavailable\n");
    return 2;
  }
  attach_argv[0] = "/usr/bin/hdiutil";
  attach_argv[1] = "attach";
  attach_argv[2] = "-readonly";
  attach_argv[3] = "-nobrowse";
  attach_argv[4] = "-mountpoint";
  attach_argv[5] = mount_template;
  attach_argv[6] = image;
  attach_argv[7] = NULL;
  if (af_run_process(attach_argv[0], attach_argv, error, sizeof(error)) != 0) {
    (void)rmdir(mount_template);
    (void)fprintf(stderr, "%s\n", error);
    return 2;
  }
  if (
    snprintf(engine, sizeof(engine), "%s/LibreOffice.app/Contents/MacOS/soffice", mount_template) >= (int)sizeof(engine)
    || access(engine, X_OK) != 0
  ) {
    engine_status = -1;
  } else {
    engine_argv = calloc((size_t)argc + 1, sizeof(*engine_argv));
    if (engine_argv == NULL) {
      engine_status = -1;
    } else {
      engine_argv[0] = engine;
      for (index = 1; index < argc; index += 1) engine_argv[index] = argv[index];
      engine_status = af_run_process(engine, engine_argv, error, sizeof(error));
      free(engine_argv);
    }
  }
  detach_argv[0] = "/usr/bin/hdiutil";
  detach_argv[1] = "detach";
  detach_argv[2] = mount_template;
  detach_argv[3] = NULL;
  detach_status = af_run_process(detach_argv[0], detach_argv, error, sizeof(error));
  (void)rmdir(mount_template);
  if (engine_status != 0 || detach_status != 0) {
    (void)fprintf(stderr, "%s\n", error[0] == '\0' ? "LibreOffice conversion failed" : error);
    return 2;
  }
  return 0;
}
