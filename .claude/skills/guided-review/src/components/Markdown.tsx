import { type ComponentChildren } from "preact";
import { type CustomComponentsOption, SnarkdownInReact } from "snarkdown-in-react";

/** a link's url, where it is one the page will follow: the web, mail, a
    place in this page, or a path relative to it - never javascript: and
    the like, which an agent's text has no business running */
const safeHref = (href: string): string | undefined =>
  /^(https?:|mailto:|#|\/|\.\/|\.\.\/)/i.test(href) || !/^[a-z][a-z0-9+.-]*:/i.test(href) ? href : undefined;

const safeSrc = (src: string): string | undefined => (/^(https?:|data:image\/)/i.test(src) ? src : undefined);

const components: CustomComponentsOption = {
  // a link opens in a tab of its own: following it here would leave the
  // review, and any edit not yet saved with it
  a: ({ href, children }: { href: string; children?: ComponentChildren }) => {
    const target = safeHref(href);
    return target === undefined ?
        <span class="md-link-refused" title={`not a link the page will follow: ${href}`}>
          {children}
        </span>
      : <a href={target} target="_blank" rel="noreferrer">
          {children}
        </a>;
  },
  img: ({ src, alt }: { src: string; alt: string }) => {
    const source = safeSrc(src);
    return source === undefined ? <span class="md-link-refused">{alt}</span> : <img src={source} alt={alt} />;
  },
};

/** markdown an agent wrote, rendered as elements - never as html, so its
    text can't inject any (snarkdown-in-react builds the tree itself) */
export const Markdown = ({ text }: { text: string }) => (
  <div class="md">
    <SnarkdownInReact markdown={text} customComponents={components} />
  </div>
);
