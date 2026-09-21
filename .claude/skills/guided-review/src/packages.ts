/* which package a path is in, so a monorepo's paths can be read from their
   package rather than from the repo root. The build found the packages (see
   packagesFor in reviewAssembly.ts); this only matches paths against them. */

import { packages, packageScope } from "./payload.ts";

export type PackagePath = {
  /** the package's directory, relative to the repo root */
  dir: string;
  /** the name to show: its package.json's, less the npm scope when every
      package in the repo shares that scope */
  name: string;
  /** its package.json's name in full */
  fullName: string;
  /** the rest of the path, inside the package - empty for the package's own
      directory */
  rest: string;
};

/** the innermost package holding a file or directory path, if any does */
export const packageOf = (path: string): PackagePath | undefined => {
  let best: PackagePath | undefined;
  for (const [dir, name] of Object.entries(packages ?? {})) {
    const inside =
      path === dir ? ""
      : path.startsWith(`${dir}/`) ? path.slice(dir.length + 1)
      : undefined;
    if (inside !== undefined && (best === undefined || dir.length > best.dir.length)) {
      const shown =
        packageScope !== undefined && name.startsWith(`${packageScope}/`) ?
          name.slice(packageScope.length + 1)
        : name;
      best = { dir, name: shown, fullName: name, rest: inside };
    }
  }
  return best;
};
