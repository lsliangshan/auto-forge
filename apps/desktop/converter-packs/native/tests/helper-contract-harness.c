#include "arguments.h"
#include "icon-container.h"

#include <stdio.h>
#include <string.h>

static int fail(const char *message) {
  (void)fprintf(stderr, "%s\n", message);
  return 2;
}

int main(int argc, char *argv[]) {
  char error[256] = {0};
  static const uint8_t first[] = {1, 2, 3};
  static const uint8_t second[] = {4, 5};
  AfIconRepresentation representations[2] = {
    {{'i', 'c', 'p', '4'}, 16, 16, first, sizeof(first)},
    {{'i', 'c', '1', '0'}, 256, 256, second, sizeof(second)},
  };

  if (argc < 2) return fail("missing harness command");
  if (strcmp(argv[1], "parse") == 0) {
    AfOption options[2] = {
      {"--format", 1, 1, 0, NULL},
      {"--all", 0, 0, 0, NULL},
    };
    const char *input = NULL;
    if (af_parse_options(argc, argv, 2, options, 2, &input, error, sizeof(error)) != 0) return fail(error);
    (void)printf("format=%s all=%d input=%s\n", options[0].value, options[1].seen, input);
    return 0;
  }
  if (argc != 3) return fail("harness command requires one path");
  if (strcmp(argv[1], "write-ico") == 0) {
    return af_write_ico(argv[2], representations, 2, error, sizeof(error)) == 0 ? 0 : fail(error);
  }
  if (strcmp(argv[1], "write-icns") == 0) {
    return af_write_icns(argv[2], representations, 2, error, sizeof(error)) == 0 ? 0 : fail(error);
  }
  if (strcmp(argv[1], "validate-ico") == 0) {
    return af_validate_ico(argv[2], error, sizeof(error)) == 0 ? 0 : fail(error);
  }
  if (strcmp(argv[1], "validate-icns") == 0) {
    return af_validate_icns(argv[2], error, sizeof(error)) == 0 ? 0 : fail(error);
  }
  return fail("unknown harness command");
}
