#include "icon-container.h"

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

#define AF_MAX_ICON_BYTES (512U * 1024U * 1024U)
#define AF_MAX_REPRESENTATIONS 256U

static int af_error(char *error, size_t capacity, const char *message) {
  if (error != NULL && capacity > 0) (void)snprintf(error, capacity, "%s", message);
  return -1;
}

static void af_u16le(uint8_t *target, uint16_t value) {
  target[0] = (uint8_t)(value & 0xffU);
  target[1] = (uint8_t)((value >> 8U) & 0xffU);
}

static void af_u32le(uint8_t *target, uint32_t value) {
  target[0] = (uint8_t)(value & 0xffU);
  target[1] = (uint8_t)((value >> 8U) & 0xffU);
  target[2] = (uint8_t)((value >> 16U) & 0xffU);
  target[3] = (uint8_t)((value >> 24U) & 0xffU);
}

static void af_u32be(uint8_t *target, uint32_t value) {
  target[0] = (uint8_t)((value >> 24U) & 0xffU);
  target[1] = (uint8_t)((value >> 16U) & 0xffU);
  target[2] = (uint8_t)((value >> 8U) & 0xffU);
  target[3] = (uint8_t)(value & 0xffU);
}

static uint16_t af_read_u16le(const uint8_t *source) {
  return (uint16_t)((uint16_t)source[0] | ((uint16_t)source[1] << 8U));
}

static uint32_t af_read_u32le(const uint8_t *source) {
  return (uint32_t)source[0]
    | ((uint32_t)source[1] << 8U)
    | ((uint32_t)source[2] << 16U)
    | ((uint32_t)source[3] << 24U);
}

static uint32_t af_read_u32be(const uint8_t *source) {
  return ((uint32_t)source[0] << 24U)
    | ((uint32_t)source[1] << 16U)
    | ((uint32_t)source[2] << 8U)
    | (uint32_t)source[3];
}

static int af_write_all(int descriptor, const uint8_t *bytes, size_t length) {
  size_t offset = 0;
  while (offset < length) {
    ssize_t written = write(descriptor, bytes + offset, length - offset);
    if (written < 0 && errno == EINTR) continue;
    if (written <= 0) return -1;
    offset += (size_t)written;
  }
  return 0;
}

static int af_write_exclusive(const char *path, const uint8_t *bytes, size_t length, char *error, size_t capacity) {
  int descriptor;
  int failed = 0;
  if (path == NULL || bytes == NULL || length == 0) return af_error(error, capacity, "invalid icon output");
  descriptor = open(path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, S_IRUSR | S_IWUSR);
  if (descriptor < 0) return af_error(error, capacity, "icon output could not be created");
  if (af_write_all(descriptor, bytes, length) != 0 || fsync(descriptor) != 0) failed = 1;
  if (close(descriptor) != 0) failed = 1;
  if (failed) {
    (void)unlink(path);
    return af_error(error, capacity, "icon output could not be written");
  }
  return 0;
}

static int af_validate_representations(
  const AfIconRepresentation representations[],
  size_t count,
  int require_types,
  size_t base,
  size_t per_entry,
  size_t *total,
  char *error,
  size_t capacity
) {
  size_t index;
  size_t value;
  if (representations == NULL || count == 0 || count > AF_MAX_REPRESENTATIONS) {
    return af_error(error, capacity, "invalid icon representations");
  }
  if (count > (AF_MAX_ICON_BYTES - base) / per_entry) return af_error(error, capacity, "icon container is too large");
  value = base + count * per_entry;
  for (index = 0; index < count; index += 1) {
    const AfIconRepresentation *representation = &representations[index];
    if (
      representation->data == NULL
      || representation->data_length == 0
      || representation->data_length > UINT32_MAX
      || representation->width < 1
      || representation->width > (require_types ? 1024 : 256)
      || representation->height < 1
      || representation->height > (require_types ? 1024 : 256)
    ) return af_error(error, capacity, "invalid icon representation");
    if (require_types && memchr(representation->type, '\0', 4) != NULL) {
      return af_error(error, capacity, "invalid ICNS representation type");
    }
    if (representation->data_length > AF_MAX_ICON_BYTES - value) return af_error(error, capacity, "icon container is too large");
    value += representation->data_length;
  }
  *total = value;
  return 0;
}

int af_write_ico(
  const char *path,
  const AfIconRepresentation representations[],
  size_t count,
  char *error,
  size_t error_capacity
) {
  size_t total;
  size_t index;
  size_t payload_offset;
  uint8_t *bytes;
  int result;
  if (af_validate_representations(representations, count, 0, 6, 16, &total, error, error_capacity) != 0) return -1;
  bytes = calloc(total, 1);
  if (bytes == NULL) return af_error(error, error_capacity, "icon memory allocation failed");
  af_u16le(bytes + 2, 1);
  af_u16le(bytes + 4, (uint16_t)count);
  payload_offset = 6 + count * 16;
  for (index = 0; index < count; index += 1) {
    const AfIconRepresentation *representation = &representations[index];
    uint8_t *entry = bytes + 6 + index * 16;
    entry[0] = representation->width == 256 ? 0 : (uint8_t)representation->width;
    entry[1] = representation->height == 256 ? 0 : (uint8_t)representation->height;
    af_u16le(entry + 4, 1);
    af_u16le(entry + 6, 32);
    af_u32le(entry + 8, (uint32_t)representation->data_length);
    af_u32le(entry + 12, (uint32_t)payload_offset);
    memcpy(bytes + payload_offset, representation->data, representation->data_length);
    payload_offset += representation->data_length;
  }
  result = af_write_exclusive(path, bytes, total, error, error_capacity);
  free(bytes);
  return result;
}

int af_write_icns(
  const char *path,
  const AfIconRepresentation representations[],
  size_t count,
  char *error,
  size_t error_capacity
) {
  size_t total;
  size_t index;
  size_t offset = 8;
  uint8_t *bytes;
  int result;
  if (af_validate_representations(representations, count, 1, 8, 8, &total, error, error_capacity) != 0) return -1;
  bytes = calloc(total, 1);
  if (bytes == NULL) return af_error(error, error_capacity, "icon memory allocation failed");
  memcpy(bytes, "icns", 4);
  af_u32be(bytes + 4, (uint32_t)total);
  for (index = 0; index < count; index += 1) {
    const AfIconRepresentation *representation = &representations[index];
    memcpy(bytes + offset, representation->type, 4);
    af_u32be(bytes + offset + 4, (uint32_t)(8 + representation->data_length));
    memcpy(bytes + offset + 8, representation->data, representation->data_length);
    offset += 8 + representation->data_length;
  }
  result = af_write_exclusive(path, bytes, total, error, error_capacity);
  free(bytes);
  return result;
}

static int af_read_regular(const char *path, uint8_t **bytes, size_t *length, char *error, size_t capacity) {
  int descriptor;
  struct stat metadata;
  size_t offset = 0;
  if (path == NULL || bytes == NULL || length == NULL) return af_error(error, capacity, "invalid icon input");
  descriptor = open(path, O_RDONLY | O_NOFOLLOW);
  if (descriptor < 0) return af_error(error, capacity, "icon input could not be opened");
  if (
    fstat(descriptor, &metadata) != 0
    || !S_ISREG(metadata.st_mode)
    || metadata.st_nlink != 1
    || metadata.st_size < 1
    || (uint64_t)metadata.st_size > AF_MAX_ICON_BYTES
  ) {
    (void)close(descriptor);
    return af_error(error, capacity, "icon input is not a bounded regular file");
  }
  *length = (size_t)metadata.st_size;
  *bytes = malloc(*length);
  if (*bytes == NULL) {
    (void)close(descriptor);
    return af_error(error, capacity, "icon memory allocation failed");
  }
  while (offset < *length) {
    ssize_t amount = read(descriptor, *bytes + offset, *length - offset);
    if (amount < 0 && errno == EINTR) continue;
    if (amount <= 0) {
      free(*bytes);
      *bytes = NULL;
      (void)close(descriptor);
      return af_error(error, capacity, "icon input could not be read");
    }
    offset += (size_t)amount;
  }
  if (close(descriptor) != 0) {
    free(*bytes);
    *bytes = NULL;
    return af_error(error, capacity, "icon input could not be read");
  }
  return 0;
}

int af_validate_ico(const char *path, char *error, size_t error_capacity) {
  uint8_t *bytes = NULL;
  size_t length = 0;
  size_t count;
  size_t table_end;
  size_t expected_offset;
  size_t index;
  int result = -1;
  if (af_read_regular(path, &bytes, &length, error, error_capacity) != 0) return -1;
  if (length < 6 || af_read_u16le(bytes) != 0 || af_read_u16le(bytes + 2) != 1) goto invalid;
  count = af_read_u16le(bytes + 4);
  if (count == 0 || count > AF_MAX_REPRESENTATIONS || count > (length - 6) / 16) goto invalid;
  table_end = 6 + count * 16;
  expected_offset = table_end;
  for (index = 0; index < count; index += 1) {
    const uint8_t *entry = bytes + 6 + index * 16;
    uint32_t data_length = af_read_u32le(entry + 8);
    uint32_t data_offset = af_read_u32le(entry + 12);
    if (
      af_read_u16le(entry + 4) != 1
      || af_read_u16le(entry + 6) != 32
      || data_length == 0
      || data_offset != expected_offset
      || data_length > length - expected_offset
    ) goto invalid;
    expected_offset += data_length;
  }
  if (expected_offset != length) goto invalid;
  result = 0;
  goto done;
invalid:
  (void)af_error(error, error_capacity, "invalid ICO container");
done:
  free(bytes);
  return result;
}

int af_validate_icns(const char *path, char *error, size_t error_capacity) {
  uint8_t *bytes = NULL;
  size_t length = 0;
  size_t offset = 8;
  size_t count = 0;
  int result = -1;
  if (af_read_regular(path, &bytes, &length, error, error_capacity) != 0) return -1;
  if (length < 17 || memcmp(bytes, "icns", 4) != 0 || af_read_u32be(bytes + 4) != length) goto invalid;
  while (offset < length) {
    uint32_t entry_length;
    if (length - offset < 8) goto invalid;
    entry_length = af_read_u32be(bytes + offset + 4);
    if (entry_length < 9 || entry_length > length - offset) goto invalid;
    offset += entry_length;
    count += 1;
    if (count > AF_MAX_REPRESENTATIONS) goto invalid;
  }
  if (offset != length || count == 0) goto invalid;
  result = 0;
  goto done;
invalid:
  (void)af_error(error, error_capacity, "invalid ICNS container");
done:
  free(bytes);
  return result;
}

int af_icon_representation_count(
  const char *path,
  int icns,
  size_t *count,
  char *error,
  size_t error_capacity
) {
  uint8_t *bytes = NULL;
  size_t length = 0;
  size_t offset;
  size_t found = 0;
  if (count == NULL) return af_error(error, error_capacity, "invalid icon count output");
  if ((icns ? af_validate_icns(path, error, error_capacity) : af_validate_ico(path, error, error_capacity)) != 0) return -1;
  if (af_read_regular(path, &bytes, &length, error, error_capacity) != 0) return -1;
  if (!icns) {
    found = af_read_u16le(bytes + 4);
  } else {
    offset = 8;
    while (offset < length) {
      offset += af_read_u32be(bytes + offset + 4);
      found += 1;
    }
  }
  free(bytes);
  *count = found;
  return 0;
}
