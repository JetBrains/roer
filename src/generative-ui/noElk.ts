// What `elkjs` resolves to in the app (see vite.config.ts). Mermaid only
// constructs it for an ELK layout, which Mermaid.tsx never lets a diagram use.
export default class NoElk {
  layout(): Promise<never> {
    return Promise.reject(new Error("The ELK layout is not available in Roer."));
  }
}
