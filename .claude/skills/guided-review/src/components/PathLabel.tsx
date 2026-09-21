import { packageOf, type PackagePath } from "../packages.ts";

/** the chip's tooltip: the name in full - scope and all - and where it's from */
export const packageTitle = ({ fullName, dir }: PackagePath): string =>
  `${fullName} — ${dir}/package.json`;

export type PathLabelProps = {
  /** a file or directory path, relative to the repo root */
  path: string;
  /** appended to the path, eg "/" after a directory */
  suffix?: string;
};

/** a path as it reads in a monorepo: the package it's in, as a chip, then the
    path inside that package. Paths outside every package read as they are */
export const PathLabel = ({ path, suffix = "" }: PathLabelProps) => {
  const found = packageOf(path);
  if (found === undefined) {
    return <>{`${path}${suffix}`}</>;
  }
  return (
    <>
      <span class="pkg-name" title={packageTitle(found)}>
        {found.name}
      </span>
      {found.rest === "" ? suffix : `${found.rest}${suffix}`}
    </>
  );
};

export type TruncatedPathLabelProps = PathLabelProps & {
  /** the span that truncates the path from its start when it doesn't fit */
  class: string;
  title?: string;
};

/** for a label that truncates from the start when space runs out: the package
    chip sits outside the truncating span and never shrinks, since which
    package a path is in is the part least worth losing */
export const TruncatedPathLabel = ({
  path,
  suffix = "",
  class: className,
  title,
}: TruncatedPathLabelProps) => {
  const found = packageOf(path);
  return (
    <>
      {found !== undefined && (
        <span class="pkg-name" title={packageTitle(found)}>
          {found.name}
        </span>
      )}
      {(found === undefined || found.rest !== "" || suffix !== "") && (
        <span class={className} title={title ?? path}>
          <span>{`${found === undefined ? path : found.rest}${suffix}`}</span>
        </span>
      )}
    </>
  );
};
