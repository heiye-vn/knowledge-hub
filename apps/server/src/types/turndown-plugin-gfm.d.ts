declare module 'turndown-plugin-gfm' {
  import type TurndownService from 'turndown';

  export type Plugin = (service: TurndownService) => void;

  export const gfm: Plugin;
  export const highlightedCodeBlock: Plugin;
  export const strikethrough: Plugin;
  export const tables: Plugin;
  export const taskListItems: Plugin;

  const plugins: {
    gfm: Plugin;
    highlightedCodeBlock: Plugin;
    strikethrough: Plugin;
    tables: Plugin;
    taskListItems: Plugin;
  };

  export default plugins;
}
