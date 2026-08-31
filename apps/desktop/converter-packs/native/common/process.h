#ifndef AUTOFORGE_PROCESS_H
#define AUTOFORGE_PROCESS_H

#include <stddef.h>

int af_sibling_executable(const char *name, char *output, size_t output_capacity, char *error, size_t error_capacity);
int af_run_process(const char *executable, char *const argv[], char *error, size_t error_capacity);

#endif
