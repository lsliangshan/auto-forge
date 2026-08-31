#define _DARWIN_C_SOURCE

#include "arguments.h"
#include "icon-container.h"
#include "process.h"

#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#ifndef O_NOFOLLOW
#define O_NOFOLLOW 0
#endif

#define AF_MAX_ICON_REPRESENTATIONS 16
#define AF_MAX_REPRESENTATION_BYTES (64U * 1024U * 1024U)

static int fail(const char *message) {
  (void)fprintf(stderr, "%s\n", message);
  return 2;
}

static int absolute_path(const char *value) {
  return value != NULL && value[0] == '/' && strstr(value, "/../") == NULL && strstr(value, "/./") == NULL;
}

static const char *static_output_suffix(const char *format) {
  if (strcmp(format, "png") == 0) return ".png";
  if (strcmp(format, "jpeg") == 0) return ".jpeg";
  if (strcmp(format, "webp") == 0) return ".webp";
  if (strcmp(format, "avif") == 0) return ".avif";
  if (strcmp(format, "tiff") == 0) return ".tiff";
  if (strcmp(format, "bmp") == 0) return ".bmp";
  if (strcmp(format, "pdf") == 0) return ".pdf";
  return NULL;
}

static int supported_image_input(const char *format) {
  return strcmp(format, "png") == 0
    || strcmp(format, "jpeg") == 0
    || strcmp(format, "webp") == 0
    || strcmp(format, "avif") == 0
    || strcmp(format, "tiff") == 0
    || strcmp(format, "bmp") == 0
    || strcmp(format, "gif") == 0
    || strcmp(format, "svg") == 0;
}

static int path_has_suffix(const char *path, const char *suffix) {
  size_t path_length = strlen(path);
  size_t suffix_length = strlen(suffix);
  return path_length > suffix_length && strcmp(path + path_length - suffix_length, suffix) == 0;
}

static int parse_sizes(const char *value, uint16_t sizes[], size_t *count) {
  const char *cursor = value;
  size_t found = 0;
  if (value == NULL || value[0] == '\0') return -1;
  while (*cursor != '\0') {
    unsigned long parsed = 0;
    if (found >= AF_MAX_ICON_REPRESENTATIONS || *cursor < '0' || *cursor > '9') return -1;
    while (*cursor >= '0' && *cursor <= '9') {
      parsed = parsed * 10U + (unsigned long)(*cursor - '0');
      if (parsed > 256U) return -1;
      cursor += 1;
    }
    if (parsed < 1U) return -1;
    sizes[found] = (uint16_t)parsed;
    found += 1;
    if (*cursor == '\0') break;
    if (*cursor != ',') return -1;
    cursor += 1;
  }
  *count = found;
  return 0;
}

static int parse_icns_representations(
  const char *value,
  uint16_t sizes[],
  char types[][4],
  size_t *count
) {
  const char *cursor = value;
  size_t found = 0;
  if (value == NULL || value[0] == '\0') return -1;
  while (*cursor != '\0') {
    unsigned long logical = 0;
    unsigned long scale = 0;
    size_t type_index;
    if (found >= AF_MAX_ICON_REPRESENTATIONS) return -1;
    for (type_index = 0; type_index < 4; type_index += 1) {
      if (cursor[type_index] == '\0' || cursor[type_index] == ',' || cursor[type_index] == '=') return -1;
      types[found][type_index] = cursor[type_index];
    }
    cursor += 4;
    if (*cursor != '=') return -1;
    cursor += 1;
    if (*cursor < '0' || *cursor > '9') return -1;
    while (*cursor >= '0' && *cursor <= '9') {
      logical = logical * 10U + (unsigned long)(*cursor - '0');
      if (logical > 1024U) return -1;
      cursor += 1;
    }
    if (*cursor != '@') return -1;
    cursor += 1;
    if (*cursor < '0' || *cursor > '9') return -1;
    while (*cursor >= '0' && *cursor <= '9') {
      scale = scale * 10U + (unsigned long)(*cursor - '0');
      if (scale > 4U) return -1;
      cursor += 1;
    }
    if (*cursor != 'x' || logical < 1U || scale < 1U || logical > 1024U || scale > 4U || logical * scale > 1024U) return -1;
    sizes[found] = (uint16_t)(logical * scale);
    found += 1;
    cursor += 1;
    if (*cursor == '\0') break;
    if (*cursor != ',') return -1;
    cursor += 1;
  }
  *count = found;
  return 0;
}

static int parse_indexes(const char *value, uint16_t indexes[], size_t *count) {
  const char *cursor = value;
  size_t found = 0;
  if (value == NULL || value[0] == '\0') return -1;
  while (*cursor != '\0') {
    unsigned long parsed = 0;
    if (found >= 256 || *cursor < '0' || *cursor > '9') return -1;
    while (*cursor >= '0' && *cursor <= '9') {
      parsed = parsed * 10U + (unsigned long)(*cursor - '0');
      if (parsed > 256U) return -1;
      cursor += 1;
    }
    if (parsed < 1U || (found > 0 && parsed <= indexes[found - 1])) return -1;
    indexes[found] = (uint16_t)parsed;
    found += 1;
    if (*cursor == '\0') break;
    if (*cursor != ',') return -1;
    cursor += 1;
  }
  *count = found;
  return 0;
}

static int read_regular(const char *path, uint8_t **bytes, size_t *length) {
  int descriptor = open(path, O_RDONLY | O_NOFOLLOW);
  struct stat metadata;
  size_t offset = 0;
  if (descriptor < 0 || fstat(descriptor, &metadata) != 0 || !S_ISREG(metadata.st_mode) || metadata.st_nlink != 1
    || metadata.st_size < 1 || (uint64_t)metadata.st_size > AF_MAX_REPRESENTATION_BYTES) {
    if (descriptor >= 0) (void)close(descriptor);
    return -1;
  }
  *length = (size_t)metadata.st_size;
  *bytes = malloc(*length);
  if (*bytes == NULL) {
    (void)close(descriptor);
    return -1;
  }
  while (offset < *length) {
    ssize_t amount = read(descriptor, *bytes + offset, *length - offset);
    if (amount < 0 && errno == EINTR) continue;
    if (amount <= 0) {
      free(*bytes);
      *bytes = NULL;
      (void)close(descriptor);
      return -1;
    }
    offset += (size_t)amount;
  }
  return close(descriptor) == 0 ? 0 : -1;
}

static int convert_command(int argc, char *argv[], const char *vips) {
  char error[256] = {0};
  const char *input = NULL;
  const char *output_suffix;
  AfOption options[] = {
    {"--input-format", 1, 1, 0, NULL},
    {"--output-format", 1, 1, 0, NULL},
    {"--frame", 1, 0, 0, NULL},
    {"--output", 1, 1, 0, NULL},
  };
  char *child[5];
  if (af_parse_options(argc, argv, 2, options, 4, &input, error, sizeof(error)) != 0) return fail(error);
  if (!absolute_path(input) || !absolute_path(options[3].value)) return fail("convert paths must be absolute");
  output_suffix = static_output_suffix(options[1].value);
  if (!supported_image_input(options[0].value) || output_suffix == NULL || !path_has_suffix(options[3].value, output_suffix)) {
    return fail("unsupported image format");
  }
  if (options[2].seen && strcmp(options[2].value, "first") != 0) return fail("unsupported frame selection");
  child[0] = (char *)vips;
  child[1] = "copy";
  child[2] = (char *)input;
  child[3] = (char *)options[3].value;
  child[4] = NULL;
  return af_run_process(vips, child, error, sizeof(error)) == 0 ? 0 : fail(error);
}

static int create_icon_command(int argc, char *argv[], const char *vips) {
  char error[256] = {0};
  const char *input = NULL;
  uint16_t sizes[AF_MAX_ICON_REPRESENTATIONS];
  char types[AF_MAX_ICON_REPRESENTATIONS][4] = {{0}};
  size_t count = 0;
  size_t index;
  AfIconRepresentation representations[AF_MAX_ICON_REPRESENTATIONS];
  uint8_t *owned[AF_MAX_ICON_REPRESENTATIONS] = {0};
  char thumbnail[AF_MAX_ICON_REPRESENTATIONS][4096] = {{0}};
  char square[AF_MAX_ICON_REPRESENTATIONS][4096] = {{0}};
  AfOption options[] = {
    {"--format", 1, 1, 0, NULL},
    {"--sizes", 1, 0, 0, NULL},
    {"--representations", 1, 0, 0, NULL},
    {"--fit", 1, 1, 0, NULL},
    {"--canvas", 1, 1, 0, NULL},
    {"--background", 1, 1, 0, NULL},
    {"--crop", 1, 1, 0, NULL},
    {"--frame", 1, 0, 0, NULL},
    {"--output", 1, 1, 0, NULL},
  };
  int result = 2;
  if (af_parse_options(argc, argv, 2, options, 9, &input, error, sizeof(error)) != 0) return fail(error);
  if (
    !absolute_path(input)
    || !absolute_path(options[8].value)
    || strcmp(options[3].value, "contain") != 0
    || strcmp(options[4].value, "square") != 0
    || strcmp(options[5].value, "transparent") != 0
    || strcmp(options[6].value, "never") != 0
    || (options[7].seen && strcmp(options[7].value, "first") != 0)
  ) return fail("invalid fixed icon contract");
  if (
    (strcmp(options[0].value, "ico") != 0 && strcmp(options[0].value, "icns") != 0)
    || options[1].seen == options[2].seen
    || (strcmp(options[0].value, "ico") == 0 && !options[1].seen)
    || (strcmp(options[0].value, "icns") == 0 && !options[2].seen)
  ) {
    return fail("unsupported icon representation contract");
  }
  if (
    (options[1].seen && parse_sizes(options[1].value, sizes, &count) != 0)
    || (options[2].seen && parse_icns_representations(options[2].value, sizes, types, &count) != 0)
  ) return fail("invalid icon sizes");

  for (index = 0; index < count; index += 1) {
    char size_text[8];
    char *thumbnail_args[11];
    char *gravity_args[13];
    if (
      snprintf(thumbnail[index], sizeof(thumbnail[index]), "%s.autoforge-%ld-%zu-thumb.png", options[8].value, (long)getpid(), index) >= (int)sizeof(thumbnail[index])
      || snprintf(square[index], sizeof(square[index]), "%s.autoforge-%ld-%zu-square.png", options[8].value, (long)getpid(), index) >= (int)sizeof(square[index])
      || snprintf(size_text, sizeof(size_text), "%u", (unsigned)sizes[index]) >= (int)sizeof(size_text)
    ) goto cleanup;
    thumbnail_args[0] = (char *)vips;
    thumbnail_args[1] = "thumbnail";
    thumbnail_args[2] = (char *)input;
    thumbnail_args[3] = thumbnail[index];
    thumbnail_args[4] = size_text;
    thumbnail_args[5] = "--height";
    thumbnail_args[6] = size_text;
    thumbnail_args[7] = "--size";
    thumbnail_args[8] = "down";
    thumbnail_args[9] = "--no-rotate";
    thumbnail_args[10] = NULL;
    if (af_run_process(vips, thumbnail_args, error, sizeof(error)) != 0) goto cleanup;
    gravity_args[0] = (char *)vips;
    gravity_args[1] = "gravity";
    gravity_args[2] = thumbnail[index];
    gravity_args[3] = square[index];
    gravity_args[4] = "centre";
    gravity_args[5] = size_text;
    gravity_args[6] = size_text;
    gravity_args[7] = "--extend";
    gravity_args[8] = "background";
    gravity_args[9] = "--background";
    gravity_args[10] = "0 0 0 0";
    gravity_args[11] = NULL;
    gravity_args[12] = NULL;
    if (af_run_process(vips, gravity_args, error, sizeof(error)) != 0) goto cleanup;
    if (read_regular(square[index], &owned[index], &representations[index].data_length) != 0) goto cleanup;
    memcpy(representations[index].type, types[index], 4);
    representations[index].width = sizes[index];
    representations[index].height = sizes[index];
    representations[index].data = owned[index];
  }
  if (
    (strcmp(options[0].value, "ico") == 0 && af_write_ico(options[8].value, representations, count, error, sizeof(error)) != 0)
    || (strcmp(options[0].value, "icns") == 0 && af_write_icns(options[8].value, representations, count, error, sizeof(error)) != 0)
  ) goto cleanup;
  result = 0;
cleanup:
  for (index = 0; index < count; index += 1) {
    free(owned[index]);
    if (thumbnail[index][0] != '\0') (void)unlink(thumbnail[index]);
    if (square[index][0] != '\0') (void)unlink(square[index]);
  }
  if (result != 0) return fail(error[0] == '\0' ? "icon conversion failed" : error);
  return 0;
}

static int extract_icon_command(int argc, char *argv[], const char *vips) {
  char error[256] = {0};
  const char *input = NULL;
  const char *placeholder;
  const char *suffix;
  const char *expected_suffix;
  size_t representation_count = 0;
  uint16_t indexes[256];
  size_t index_count = 0;
  size_t index;
  AfOption options[] = {
    {"--input-format", 1, 1, 0, NULL},
    {"--output-format", 1, 1, 0, NULL},
    {"--all-representations", 0, 1, 0, NULL},
    {"--representation-indexes", 1, 0, 0, NULL},
    {"--output-pattern", 1, 1, 0, NULL},
  };
  if (af_parse_options(argc, argv, 2, options, 5, &input, error, sizeof(error)) != 0) return fail(error);
  if (
    !absolute_path(input)
    || !absolute_path(options[4].value)
    || (strcmp(options[0].value, "ico") != 0 && strcmp(options[0].value, "icns") != 0)
  ) return fail("invalid fixed icon extraction contract");
  expected_suffix = static_output_suffix(options[1].value);
  if (expected_suffix == NULL) return fail("invalid fixed icon extraction contract");
  placeholder = strstr(options[4].value, "%03d");
  if (placeholder == NULL || strstr(placeholder + 4, "%03d") != NULL) return fail("invalid icon output pattern");
  suffix = placeholder + 4;
  if (strcmp(suffix, expected_suffix) != 0) return fail("invalid icon output pattern");
  if (af_icon_representation_count(input, strcmp(options[0].value, "icns") == 0, &representation_count, error, sizeof(error)) != 0) {
    return fail(error);
  }
  if (strcmp(options[0].value, "ico") == 0) {
    if (!options[3].seen || parse_indexes(options[3].value, indexes, &index_count) != 0 || index_count != representation_count) {
      return fail("invalid ICO representation indexes");
    }
  } else {
    if (options[3].seen || representation_count > 256) return fail("invalid ICNS representation indexes");
    index_count = representation_count;
    for (index = 0; index < index_count; index += 1) indexes[index] = (uint16_t)(index + 1);
  }
  for (index = 0; index < index_count; index += 1) {
    char input_spec[4096];
    char output[4096];
    char *child[5];
    int input_length = snprintf(input_spec, sizeof(input_spec), "%s[page=%u,n=1]", input, (unsigned)(indexes[index] - 1));
    int output_length = snprintf(
      output,
      sizeof(output),
      "%.*s%03u%s",
      (int)(placeholder - options[4].value),
      options[4].value,
      (unsigned)indexes[index],
      suffix
    );
    if (input_length < 0 || input_length >= (int)sizeof(input_spec) || output_length < 0 || output_length >= (int)sizeof(output)) {
      return fail("icon extraction path is too long");
    }
    child[0] = (char *)vips;
    child[1] = "copy";
    child[2] = input_spec;
    child[3] = output;
    child[4] = NULL;
    if (af_run_process(vips, child, error, sizeof(error)) != 0) return fail(error);
  }
  return 0;
}

int main(int argc, char *argv[]) {
  char error[256] = {0};
  char vips[4096];
  if (argc < 2) return fail("missing image helper command");
  if (af_sibling_executable("vips", vips, sizeof(vips), error, sizeof(error)) != 0) return fail(error);
  if (strcmp(argv[1], "convert") == 0) return convert_command(argc, argv, vips);
  if (strcmp(argv[1], "create-icon") == 0) return create_icon_command(argc, argv, vips);
  if (strcmp(argv[1], "extract-icon") == 0) return extract_icon_command(argc, argv, vips);
  return fail("unsupported image helper command");
}
