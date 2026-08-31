#ifndef AUTOFORGE_ICON_CONTAINER_H
#define AUTOFORGE_ICON_CONTAINER_H

#include <stddef.h>
#include <stdint.h>

typedef struct {
  char type[4];
  uint16_t width;
  uint16_t height;
  const uint8_t *data;
  size_t data_length;
} AfIconRepresentation;

int af_write_ico(
  const char *path,
  const AfIconRepresentation representations[],
  size_t count,
  char *error,
  size_t error_capacity
);

int af_write_icns(
  const char *path,
  const AfIconRepresentation representations[],
  size_t count,
  char *error,
  size_t error_capacity
);

int af_validate_ico(const char *path, char *error, size_t error_capacity);
int af_validate_icns(const char *path, char *error, size_t error_capacity);
int af_icon_representation_count(
  const char *path,
  int icns,
  size_t *count,
  char *error,
  size_t error_capacity
);

#endif
