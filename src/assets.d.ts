/**
 * Module declarations for static assets imported as Text modules.
 *
 * Wrangler bundles these files into the worker as strings (see its module
 * rules); the admin panel serves them back verbatim behind the admin cookie.
 * Importing them as `string` keeps tsc happy while esbuild/wrangler handle
 * the actual inlining at build time.
 */
declare module '*.html' {
  const content: string;
  export default content;
}

declare module '*.css' {
  const content: string;
  export default content;
}

declare module '*.js' {
  const content: string;
  export default content;
}
