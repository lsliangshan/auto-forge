#include "arguments.h"

#include <stdio.h>
#include <string.h>

static int af_error(char *error, size_t capacity, const char *message) {
  if (error != NULL && capacity > 0) {
    (void)snprintf(error, capacity, "%s", message);
  }
  return -1;
}

int af_parse_options(
  int argc,
  char *const argv[],
  int start,
  AfOption options[],
  size_t option_count,
  const char **input,
  char *error,
  size_t error_capacity
) {
  int delimiter = -1;
  int index;
  size_t option_index;

  if (argc < 0 || argv == NULL || start < 0 || start > argc || options == NULL || input == NULL) {
    return af_error(error, error_capacity, "invalid parser input");
  }
  *input = NULL;
  for (index = start; index < argc; index += 1) {
    if (strcmp(argv[index], "--") == 0) {
      delimiter = index;
      break;
    }
  }
  if (delimiter < 0) return af_error(error, error_capacity, "missing input delimiter");
  if (argc - delimiter - 1 != 1) return af_error(error, error_capacity, "exactly one input is required");

  index = start;
  while (index < delimiter) {
    AfOption *matched = NULL;
    for (option_index = 0; option_index < option_count; option_index += 1) {
      if (strcmp(argv[index], options[option_index].name) == 0) {
        matched = &options[option_index];
        break;
      }
    }
    if (matched == NULL) return af_error(error, error_capacity, "unknown option");
    if (matched->seen) return af_error(error, error_capacity, "duplicate option");
    matched->seen = 1;
    if (matched->takes_value) {
      if (index + 1 >= delimiter) return af_error(error, error_capacity, "missing option value");
      matched->value = argv[index + 1];
      index += 2;
    } else {
      matched->value = NULL;
      index += 1;
    }
  }

  for (option_index = 0; option_index < option_count; option_index += 1) {
    if (options[option_index].required && !options[option_index].seen) {
      return af_error(error, error_capacity, "missing required option");
    }
  }
  *input = argv[delimiter + 1];
  return 0;
}
