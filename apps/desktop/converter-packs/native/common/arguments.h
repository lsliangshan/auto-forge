#ifndef AUTOFORGE_ARGUMENTS_H
#define AUTOFORGE_ARGUMENTS_H

#include <stddef.h>

typedef struct {
  const char *name;
  int takes_value;
  int required;
  int seen;
  const char *value;
} AfOption;

int af_parse_options(
  int argc,
  char *const argv[],
  int start,
  AfOption options[],
  size_t option_count,
  const char **input,
  char *error,
  size_t error_capacity
);

#endif
