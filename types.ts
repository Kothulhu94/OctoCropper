export interface Point {
  x: number;
  y: number;
}

export interface RectPart {
  type: 'rect';
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PolyPart {
  type: 'poly';
  points: Point[];
}

export type Part = RectPart | PolyPart;

export interface Region {
  id: number;
  parts: Part[];
}

export interface ProcessedImage {
  id: number;
  name: string;
  dataUrl: string;
}

export type DragMode = 'body' | 'vertex' | 'n' | 'e' | 's' | 'w' | 'nw' | 'ne' | 'se' | 'sw' | null;

export interface DraggingState {
  isDragging: boolean;
  selectedRegion: Region | null;
  selectedPartIndex: number;
  selectedVertexIndex: number;
  dragMode: DragMode;
  mouseOffset: Point;
}

export interface HitResult {
    region: Region | null;
    part: Part | null;
    partIndex: number;
    vertex: Point | null;
    vertexIndex: number;
    mode: DragMode;
    cursor: string;
}

export interface ViewTransform {
  zoom: number;
  offset: Point;
}