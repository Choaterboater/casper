/* Fixed-arity bridge: openat is variadic, including a distinct arm64 macOS ABI.
 * No headers/toolchain packages are needed; Bun's built-in TinyCC links libc. */
extern int openat(int, const char *, int, ...);
extern int unlinkat(int, const char *, int);
extern int mkdirat(int, const char *, unsigned int);
#if CASPER_DARWIN
extern int *__error(void);
#define error_number (*__error())
#else
extern int *__errno_location(void);
#define error_number (*__errno_location())
#endif

int casper_openat(int directory, const char *name, int flags) {
    int fd = openat(directory, name, flags, 0600);
    return fd < 0 ? -error_number : fd;
}

int casper_mkdirat(int directory, const char *name) {
    int result = mkdirat(directory, name, 0700);
    return result < 0 ? -error_number : 0;
}

int casper_unlinkat(int directory, const char *name) {
    int result = unlinkat(directory, name, 0);
    return result < 0 ? -error_number : 0;
}
