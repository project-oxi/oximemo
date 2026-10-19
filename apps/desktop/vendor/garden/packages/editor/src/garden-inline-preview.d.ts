import type { Extension } from '@codemirror/state';

export interface GardenInlinePreviewConfig {
  onLinkClick?: (url: string) => void;
}

export declare function gardenInlinePreview(config?: GardenInlinePreviewConfig): Extension;
