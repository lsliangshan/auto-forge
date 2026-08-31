#define _DARWIN_C_SOURCE

#include "arguments.h"
#include "process.h"

#include <errno.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static int fail(const char *message) {
  (void)fprintf(stderr, "%s\n", message);
  return 2;
}

static int absolute_path(const char *value) {
  return value != NULL && value[0] == '/' && strstr(value, "/../") == NULL && strstr(value, "/./") == NULL;
}

static int normalize_outputs(const char *pattern, const char *prefix, const char *suffix, char *error, size_t capacity) {
  const char *placeholder = strstr(pattern, "%03d");
  int page;
  int found = 0;
  for (page = 1; page <= 100; page += 1) {
    char source[4096];
    char destination[4096];
    struct stat metadata;
    int source_length = snprintf(source, sizeof(source), "%s-%d%s", prefix, page, suffix);
    int destination_length = snprintf(
      destination,
      sizeof(destination),
      "%.*s%03d%s",
      (int)(placeholder - pattern),
      pattern,
      page,
      suffix
    );
    if (source_length < 0 || source_length >= (int)sizeof(source) || destination_length < 0 || destination_length >= (int)sizeof(destination)) {
      (void)snprintf(error, capacity, "PDF output path is too long");
      return -1;
    }
    if (lstat(source, &metadata) != 0) {
      if (errno == ENOENT) break;
      (void)snprintf(error, capacity, "PDF output could not be inspected");
      return -1;
    }
    if (!S_ISREG(metadata.st_mode) || metadata.st_nlink != 1) {
      (void)snprintf(error, capacity, "PDF output is not a regular file");
      return -1;
    }
    if (strcmp(source, destination) != 0) {
      if (link(source, destination) != 0 || unlink(source) != 0) {
        (void)unlink(destination);
        (void)snprintf(error, capacity, "PDF output could not be normalized");
        return -1;
      }
    }
    found += 1;
  }
  if (found == 0) {
    (void)snprintf(error, capacity, "PDF rasterizer produced no pages");
    return -1;
  }
  return 0;
}

int main(int argc, char *argv[]) {
  char error[256] = {0};
  char pdftocairo[4096];
  char prefix[4096];
  const char *input = NULL;
  const char *placeholder;
  const char *suffix;
  size_t prefix_length;
  AfOption options[] = {
    {"--format", 1, 1, 0, NULL},
    {"--pages", 1, 1, 0, NULL},
    {"--page-number-width", 1, 1, 0, NULL},
    {"--output-pattern", 1, 1, 0, NULL},
  };
  char *child[5];
  if (argc < 2 || strcmp(argv[1], "raster") != 0) return fail("unsupported PDF helper command");
  if (af_parse_options(argc, argv, 2, options, 4, &input, error, sizeof(error)) != 0) return fail(error);
  if (
    !absolute_path(input)
    || !absolute_path(options[3].value)
    || (strcmp(options[0].value, "png") != 0 && strcmp(options[0].value, "jpeg") != 0)
    || strcmp(options[1].value, "all") != 0
    || strcmp(options[2].value, "3") != 0
  ) return fail("invalid fixed PDF raster contract");
  placeholder = strstr(options[3].value, "%03d");
  if (placeholder == NULL || strstr(placeholder + 4, "%03d") != NULL) return fail("invalid PDF output pattern");
  suffix = placeholder + 4;
  if (
    (strcmp(options[0].value, "png") == 0 && strcmp(suffix, ".png") != 0)
    || (strcmp(options[0].value, "jpeg") == 0 && strcmp(suffix, ".jpeg") != 0)
  ) return fail("invalid PDF output pattern");
  prefix_length = (size_t)(placeholder - options[3].value);
  if (prefix_length < 2 || options[3].value[prefix_length - 1] != '-' || prefix_length > sizeof(prefix)) {
    return fail("invalid PDF output pattern");
  }
  memcpy(prefix, options[3].value, prefix_length - 1);
  prefix[prefix_length - 1] = '\0';
  if (af_sibling_executable("pdftocairo", pdftocairo, sizeof(pdftocairo), error, sizeof(error)) != 0) return fail(error);
  child[0] = pdftocairo;
  child[1] = strcmp(options[0].value, "png") == 0 ? "-png" : "-jpeg";
  child[2] = (char *)input;
  child[3] = prefix;
  child[4] = NULL;
  if (af_run_process(pdftocairo, child, error, sizeof(error)) != 0) return fail(error);
  if (normalize_outputs(options[3].value, prefix, suffix, error, sizeof(error)) != 0) return fail(error);
  return 0;
}
