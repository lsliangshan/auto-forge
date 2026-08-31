#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static int write_output(const char *path, const char *contents) {
  int descriptor = open(path, O_WRONLY | O_CREAT | O_EXCL, S_IRUSR | S_IWUSR);
  size_t length = strlen(contents);
  size_t offset = 0;
  if (descriptor < 0) return 2;
  while (offset < length) {
    ssize_t amount = write(descriptor, contents + offset, length - offset);
    if (amount < 0 && errno == EINTR) continue;
    if (amount <= 0) {
      (void)close(descriptor);
      return 2;
    }
    offset += (size_t)amount;
  }
  return close(descriptor) == 0 ? 0 : 2;
}

int main(int argc, char *argv[]) {
  const char *name = strrchr(argv[0], '/');
  name = name == NULL ? argv[0] : name + 1;
  if (strcmp(name, "pdftocairo") == 0) {
    char first[4096];
    char second[4096];
    const char *extension;
    const char *prefix;
    if (argc != 4) return 2;
    extension = strcmp(argv[1], "-png") == 0 ? ".png" : strcmp(argv[1], "-jpeg") == 0 ? ".jpeg" : NULL;
    if (extension == NULL) return 2;
    prefix = argv[3];
    if (snprintf(first, sizeof(first), "%s-1%s", prefix, extension) >= (int)sizeof(first)) return 2;
    if (snprintf(second, sizeof(second), "%s-2%s", prefix, extension) >= (int)sizeof(second)) return 2;
    if (write_output(first, "page-1") != 0) return 2;
    return write_output(second, "page-2");
  }
  if (argc >= 4 && strcmp(argv[1], "copy") == 0) return write_output(argv[3], "converted");
  if (argc >= 4 && (strcmp(argv[1], "thumbnail") == 0 || strcmp(argv[1], "gravity") == 0)) {
    return write_output(argv[3], "png");
  }
  return 2;
}
