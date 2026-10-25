import { useState, type ImgHTMLAttributes } from "react";

/**
 * A picture sized with the code: at the default size it fits the width it is
 * given, never past its own, and Cmd+= and Cmd+- grow and shrink it from
 * there, the box around it scrolling. Its own width is only known once it has
 * loaded; until then it is held to the box. `width`, when given (an icon in
 * a README), stands in for its own.
 */
export function Picture({ style, width, onLoad, ...rest }: ImgHTMLAttributes<HTMLImageElement>) {
  const [natural, setNatural] = useState<number | null>(null);
  const own = Number(width) || natural;
  return (
    <img
      {...rest}
      className={rest.className ? `picture ${rest.className}` : "picture"}
      style={{
        ...style,
        width: own ? `calc(min(100%, ${own}px) * var(--code-zoom, 1))` : undefined,
        maxWidth: own ? "none" : "100%",
        height: own ? "auto" : style?.height,
      }}
      onLoad={(event) => {
        setNatural(event.currentTarget.naturalWidth || null);
        onLoad?.(event);
      }}
    />
  );
}
