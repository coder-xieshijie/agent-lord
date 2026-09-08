declare module "fs-native-extensions" {
  export function tryLock(fd: number, options?: { shared?: boolean }): boolean;
  export function unlock(fd: number): void;
}
