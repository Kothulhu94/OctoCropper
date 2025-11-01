import React, { useState, useRef, useEffect, useCallback } from 'react';
import type { Point, Region, Part, ProcessedImage, DraggingState, DragMode, RectPart, HitResult, ViewTransform } from './types';

// Type declarations for global libraries loaded via CDN
declare const JSZip: any;
declare const saveAs: any;

const HANDLE_SIZE = 12; // Visual size of handles
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 10;

// --- Helper Functions (Pure) ---
const getCanvasPos = (e: React.MouseEvent | React.TouchEvent | MouseEvent | TouchEvent, canvas: HTMLCanvasElement, transform: ViewTransform): Point | null => {
    const rect = canvas.getBoundingClientRect();
    const touch = (e as TouchEvent).touches?.[0];
    const clientX = (e as MouseEvent).clientX ?? touch?.clientX;
    const clientY = (e as MouseEvent).clientY ?? touch?.clientY;

    if (clientX === undefined || clientY === undefined) return null;

    // Transform screen coordinates to image coordinates
    const screenX = clientX - rect.left;
    const screenY = clientY - rect.top;

    return {
        x: (screenX - transform.offset.x) / transform.zoom,
        y: (screenY - transform.offset.y) / transform.zoom,
    };
};

const pointInPolygon = (point: Point, vs: Point[]) => {
    const { x, y } = point;
    let inside = false;
    for (let i = 0, j = vs.length - 1; i < vs.length; j = i++) {
        const xi = vs[i].x, yi = vs[i].y;
        const xj = vs[j].x, yj = vs[j].y;
        const intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
        if (intersect) inside = !inside;
    }
    return inside;
};

const distToSegment = (p: Point, v: Point, w: Point) => {
    const l2 = (v.x - w.x) ** 2 + (v.y - w.y) ** 2;
    if (l2 === 0) return { distance: Math.hypot(p.x - v.x, p.y - v.y), point: { x: v.x, y: v.y } };

    let t = ((p.x - v.x) * (w.x - v.x) + (p.y - v.y) * (w.y - v.y)) / l2;
    t = Math.max(0, Math.min(1, t));

    const projection = { x: v.x + t * (w.x - v.x), y: v.y + t * (w.y - v.y) };
    const distance = Math.hypot(p.x - projection.x, p.y - projection.y);
    return { distance, point: projection };
};

const PlusIcon: React.FC<{ className?: string }> = ({ className = "mr-1" }) => (
    <svg className={`w-4 h-4 stroke-[2.5] inline-block align-middle ${className}`} xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
    </svg>
);

const MinusIcon: React.FC<{ className?: string }> = ({ className = "mr-1" }) => (
    <svg className={`w-4 h-4 stroke-[2.5] inline-block align-middle ${className}`} xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 12h-15" />
    </svg>
);

const TrashIcon: React.FC<{ className?: string }> = ({ className = "mr-1" }) => (
    <svg className={`w-4 h-4 stroke-[2.5] inline-block align-middle ${className}`} xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.124-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.077-2.09.921-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" />
    </svg>
);


export default function App() {
    const [originalImage, setOriginalImage] = useState<HTMLImageElement | null>(null);
    const [originalFileName, setOriginalFileName] = useState<string | null>(null);
    const [regions, setRegions] = useState<Region[]>([]);
    const [processedImages, setProcessedImages] = useState<ProcessedImage[]>([]);
    const [isSelectMode, setIsSelectMode] = useState(false);
    const [multiSelectRegions, setMultiSelectRegions] = useState<Set<number>>(new Set());
    const [isWaitingForPointClick, setIsWaitingForPointClick] = useState(false);
    const [isDeletePointMode, setIsDeletePointMode] = useState(false);
    const [isDeleteRegionMode, setIsDeleteRegionMode] = useState(false);
    const [cursor, setCursor] = useState('default');
    const [viewTransform, setViewTransform] = useState<ViewTransform>({ zoom: 1, offset: { x: 0, y: 0 } });

    const canvasRef = useRef<HTMLCanvasElement>(null);
    const canvasContainerRef = useRef<HTMLDivElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    
    const draggingStateRef = useRef<DraggingState>({
        isDragging: false,
        selectedRegion: null,
        selectedPartIndex: -1,
        selectedVertexIndex: -1,
        dragMode: null,
        mouseOffset: { x: 0, y: 0 },
    });

    const fitToScreen = useCallback(() => {
        const canvas = canvasRef.current;
        const container = canvasContainerRef.current;
        if (!originalImage || !container || !canvas) return;

        const containerWidth = container.clientWidth;
        const containerHeight = container.clientHeight;
        const imageWidth = originalImage.naturalWidth;
        const imageHeight = originalImage.naturalHeight;

        const zoomX = containerWidth / imageWidth;
        const zoomY = containerHeight / imageHeight;
        const newZoom = Math.min(zoomX, zoomY, 1); // Don't zoom in past 100% on fit

        const newOffsetX = (containerWidth - imageWidth * newZoom) / 2;
        const newOffsetY = (containerHeight - imageHeight * newZoom) / 2;

        setViewTransform({ zoom: newZoom, offset: { x: newOffsetX, y: newOffsetY } });
    }, [originalImage]);


    // --- Drawing Logic ---
    useEffect(() => {
        const canvas = canvasRef.current;
        const ctx = canvas?.getContext('2d');
        if (!ctx || !canvas) return;

        ctx.clearRect(0, 0, canvas.width, canvas.height);

        ctx.save();
        ctx.translate(viewTransform.offset.x, viewTransform.offset.y);
        ctx.scale(viewTransform.zoom, viewTransform.zoom);

        if (originalImage) {
            ctx.drawImage(originalImage, 0, 0, originalImage.naturalWidth, originalImage.naturalHeight);
        } else {
             ctx.restore();
            return;
        }

        const regionFill = 'rgba(59, 130, 246, 0.4)';
        const regionStroke = 'rgba(29, 78, 216, 0.9)';
        const selectedFill = 'rgba(234, 179, 8, 0.4)';
        const selectedStroke = 'rgba(202, 138, 4, 0.9)';
        const handleFill = 'rgba(255, 255, 255, 0.9)';
        const polyVertexFill = 'rgba(239, 68, 68, 0.9)';
        
        // Adjust handle size based on zoom for consistent appearance
        const handleSize = HANDLE_SIZE / viewTransform.zoom;
        const h2 = handleSize / 2;

        regions.forEach(region => {
            const isSelected = multiSelectRegions.has(region.id);
            ctx.fillStyle = isSelected ? selectedFill : regionFill;
            ctx.strokeStyle = isSelected ? selectedStroke : regionStroke;
            ctx.lineWidth = 2 / viewTransform.zoom;

            region.parts.forEach(part => {
                if (part.type === 'rect') {
                    ctx.fillRect(part.x, part.y, part.w, part.h);
                    ctx.strokeRect(part.x, part.y, part.w, part.h);
                    if (!isSelectMode) {
                        ctx.fillStyle = handleFill;
                        ctx.fillRect(part.x - h2, part.y - h2, handleSize, handleSize); // nw
                        ctx.fillRect(part.x + part.w - h2, part.y - h2, handleSize, handleSize); // ne
                        ctx.fillRect(part.x + part.w - h2, part.y + part.h - h2, handleSize, handleSize); // se
                        ctx.fillRect(part.x - h2, part.y + part.h - h2, handleSize, handleSize); // sw
                        ctx.fillRect(part.x + part.w / 2 - h2, part.y - h2, handleSize, handleSize); // n
                        ctx.fillRect(part.x + part.w - h2, part.y + part.h / 2 - h2, handleSize, handleSize); // e
                        ctx.fillRect(part.x + part.w / 2 - h2, part.y + part.h - h2, handleSize, handleSize); // s
                        ctx.fillRect(part.x - h2, part.y + part.h / 2 - h2, handleSize, handleSize); // w
                    }
                } else { // poly
                    ctx.beginPath();
                    ctx.moveTo(part.points[0].x, part.points[0].y);
                    part.points.slice(1).forEach(p => ctx.lineTo(p.x, p.y));
                    ctx.closePath();
                    ctx.fill();
                    ctx.stroke();
                    if (!isSelectMode) {
                        ctx.fillStyle = polyVertexFill;
                        part.points.forEach(p => ctx.fillRect(p.x - h2, p.y - h2, handleSize, handleSize));
                    }
                }
            });
        });
        ctx.restore();
    }, [originalImage, regions, multiSelectRegions, isSelectMode, viewTransform]);
    
    // Effect to handle canvas resizing
    useEffect(() => {
        const canvas = canvasRef.current;
        const container = canvasContainerRef.current;
        if (!container || !canvas) return;

        const resizeObserver = new ResizeObserver(entries => {
            for (let entry of entries) {
                const { width, height } = entry.contentRect;
                canvas.width = width;
                canvas.height = height;
                if (originalImage) {
                    fitToScreen();
                }
            }
        });

        resizeObserver.observe(container);
        return () => resizeObserver.disconnect();
    }, [originalImage, fitToScreen]);


    const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        const fileNameWithoutExt = file.name.split('.').slice(0, -1).join('.') || file.name;
        setOriginalFileName(fileNameWithoutExt);

        const reader = new FileReader();
        reader.onload = (event) => {
            const img = new Image();
            img.onload = () => {
                setOriginalImage(img);
                setRegions([]);
                setProcessedImages([]);
                setIsSelectMode(false);
                setMultiSelectRegions(new Set());
                setIsWaitingForPointClick(false);
            };
            img.src = event.target.result as string;
        };
        reader.readAsDataURL(file);
    };
    
    useEffect(() => {
        if(originalImage) {
            fitToScreen();
        }
    }, [originalImage, fitToScreen]);

    const addRegion = () => {
        if (!originalImage) return;
        const defaultSize = Math.min(originalImage.naturalWidth, originalImage.naturalHeight) * 0.25;
        const newRegion: Region = {
            id: Date.now(),
            parts: [{
                type: 'rect',
                x: (originalImage.naturalWidth / 2) - (defaultSize / 2),
                y: (originalImage.naturalHeight / 2) - (defaultSize / 2),
                w: defaultSize,
                h: defaultSize,
            }]
        };
        setRegions(prev => [...prev, newRegion]);
    };
    
    const cancelAddPointMode = () => {
        setIsWaitingForPointClick(false);
        setCursor('default');
    };
    
    const toggleSelectMode = () => {
        setIsSelectMode(prev => !prev);
        if (isWaitingForPointClick) cancelAddPointMode();
        if (isDeletePointMode) setIsDeletePointMode(false);
        if (isDeleteRegionMode) setIsDeleteRegionMode(false);
        setMultiSelectRegions(new Set());
    };
    
    const startAddPointMode = () => {
        if (isWaitingForPointClick) {
            cancelAddPointMode();
            return;
        }
        setIsWaitingForPointClick(true);
        if (isSelectMode) setIsSelectMode(false);
        if (isDeletePointMode) setIsDeletePointMode(false);
        if (isDeleteRegionMode) setIsDeleteRegionMode(false);
        setMultiSelectRegions(new Set());
        setCursor('crosshair');
    };

    const toggleDeletePointMode = () => {
        const turningOn = !isDeletePointMode;
        setIsDeletePointMode(turningOn);
        if (turningOn) {
            if (isSelectMode) setIsSelectMode(false);
            if (isWaitingForPointClick) cancelAddPointMode();
            if (isDeleteRegionMode) setIsDeleteRegionMode(false);
            setCursor('crosshair');
        } else {
            setCursor('default');
        }
    };

    const toggleDeleteRegionMode = () => {
        const turningOn = !isDeleteRegionMode;
        setIsDeleteRegionMode(turningOn);
        if (turningOn) {
            if (isSelectMode) setIsSelectMode(false);
            if (isWaitingForPointClick) cancelAddPointMode();
            if (isDeletePointMode) setIsDeletePointMode(false);
            setCursor('pointer');
        } else {
            setCursor('default');
        }
    };
    
    const updateSelectionDependentButtons = useCallback(() => {
        // This function is now mostly for logic separation,
        // as button disabled states are handled in JSX.
    }, []);

    const findClosestEdgePoint = useCallback((pos: Point, allRegions: Region[]) => {
        let minDistance = Infinity;
        let closestRegion: Region | null = null;
        let closestPartIndex = -1;
        let closestSegmentIndex = -1;
        let closestPoint: Point | null = null;
        const threshold = HANDLE_SIZE / viewTransform.zoom;

        allRegions.forEach(region => {
            region.parts.forEach((part, partIdx) => {
                let segments: { p1: Point; p2: Point; index: number }[] = [];
                if (part.type === 'poly') {
                    for (let i = 0; i < part.points.length; i++) {
                        segments.push({ p1: part.points[i], p2: part.points[(i + 1) % part.points.length], index: i });
                    }
                } else if (part.type === 'rect') {
                    const p1 = { x: part.x, y: part.y };
                    const p2 = { x: part.x + part.w, y: part.y };
                    const p3 = { x: part.x + part.w, y: part.y + part.h };
                    const p4 = { x: part.x, y: part.y + part.h };
                    segments = [
                        { p1, p2, index: 0 }, { p1: p2, p2: p3, index: 1 },
                        { p1: p3, p2: p4, index: 2 }, { p1: p4, p2: p1, index: 3 }
                    ];
                }
                segments.forEach(seg => {
                    const { distance, point } = distToSegment(pos, seg.p1, seg.p2);
                    if (distance < minDistance) {
                        minDistance = distance;
                        closestRegion = region;
                        closestPartIndex = partIdx;
                        closestSegmentIndex = seg.index;
                        closestPoint = point;
                    }
                });
            });
        });
        if (minDistance > threshold) return { region: null, partIndex: -1, segmentIndex: -1, newPoint: null };
        return { region: closestRegion, partIndex: closestPartIndex, segmentIndex: closestSegmentIndex, newPoint: closestPoint };
    }, [viewTransform.zoom]);
    
    const addPointToPolygon = (e: React.MouseEvent<HTMLCanvasElement>) => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const pos = getCanvasPos(e, canvas, viewTransform);
        if (!pos) {
            cancelAddPointMode();
            return;
        }

        const { region, partIndex, segmentIndex, newPoint } = findClosestEdgePoint(pos, regions);

        if (region && partIndex !== -1 && segmentIndex !== -1 && newPoint) {
            setRegions(prevRegions => {
                const newRegions = [...prevRegions];
                const regionToUpdate = newRegions.find(r => r.id === region.id);
                if (!regionToUpdate) return prevRegions;

                const partToUpdate = regionToUpdate.parts[partIndex];

                if (partToUpdate.type === 'rect') {
                    const p = partToUpdate as RectPart;
                    const newPoints = [
                        { x: p.x, y: p.y },
                        { x: p.x + p.w, y: p.y },
                        { x: p.x + p.w, y: p.y + p.h },
                        { x: p.x, y: p.y + p.h },
                    ];
                    newPoints.splice(segmentIndex + 1, 0, newPoint);
                    regionToUpdate.parts[partIndex] = { type: 'poly', points: newPoints };
                } else {
                    partToUpdate.points.splice(segmentIndex + 1, 0, newPoint);
                }
                return newRegions;
            });
        }
    };

    const mergeSelectedRegions = () => {
        if (multiSelectRegions.size < 2) return;
        const regionsToMerge: Region[] = [];
        const remainingRegions: Region[] = [];
        regions.forEach(r => {
            if (multiSelectRegions.has(r.id)) {
                regionsToMerge.push(r);
            } else {
                remainingRegions.push(r);
            }
        });
        const newParts = regionsToMerge.flatMap(r => r.parts);
        const mergedRegion: Region = { id: Date.now(), parts: newParts };
        setRegions([...remainingRegions, mergedRegion]);
        setMultiSelectRegions(new Set());
    };

    const clearAllRegions = () => {
        setRegions([]);
        setProcessedImages([]);
        setIsSelectMode(false);
        setMultiSelectRegions(new Set());
        if (isWaitingForPointClick) cancelAddPointMode();
        if (isDeletePointMode) setIsDeletePointMode(false);
        if (isDeleteRegionMode) setIsDeleteRegionMode(false);
    };

    const getHitRegion = useCallback((pos: Point): HitResult => {
        const threshold = HANDLE_SIZE / viewTransform.zoom;
        const h2 = threshold / 2;
        
        for (let i = regions.length - 1; i >= 0; i--) {
            const region = regions[i];
            for (let j = 0; j < region.parts.length; j++) {
                const part = region.parts[j];
                if (part.type === 'rect') {
                    if (!isSelectMode && !isWaitingForPointClick && !isDeletePointMode && !isDeleteRegionMode) {
                        const { x, y, w, h } = part;
                        if (Math.abs(pos.x - x) < h2 && Math.abs(pos.y - y) < h2) return { region, part, partIndex: j, vertex: null, vertexIndex: -1, mode: 'nw', cursor: 'nwse-resize' };
                        if (Math.abs(pos.x - (x + w)) < h2 && Math.abs(pos.y - y) < h2) return { region, part, partIndex: j, vertex: null, vertexIndex: -1, mode: 'ne', cursor: 'nesw-resize' };
                        if (Math.abs(pos.x - (x + w)) < h2 && Math.abs(pos.y - (y + h)) < h2) return { region, part, partIndex: j, vertex: null, vertexIndex: -1, mode: 'se', cursor: 'nwse-resize' };
                        if (Math.abs(pos.x - x) < h2 && Math.abs(pos.y - (y + h)) < h2) return { region, part, partIndex: j, vertex: null, vertexIndex: -1, mode: 'sw', cursor: 'nesw-resize' };
                        if (Math.abs(pos.x - (x + w / 2)) < h2 && Math.abs(pos.y - y) < h2) return { region, part, partIndex: j, vertex: null, vertexIndex: -1, mode: 'n', cursor: 'ns-resize' };
                        if (Math.abs(pos.x - (x + w)) < h2 && Math.abs(pos.y - (y + h / 2)) < h2) return { region, part, partIndex: j, vertex: null, vertexIndex: -1, mode: 'e', cursor: 'ew-resize' };
                        if (Math.abs(pos.x - (x + w / 2)) < h2 && Math.abs(pos.y - (y + h)) < h2) return { region, part, partIndex: j, vertex: null, vertexIndex: -1, mode: 's', cursor: 'ns-resize' };
                        if (Math.abs(pos.x - x) < h2 && Math.abs(pos.y - (y + h / 2)) < h2) return { region, part, partIndex: j, vertex: null, vertexIndex: -1, mode: 'w', cursor: 'ew-resize' };
                    }
                    if (pos.x > part.x && pos.x < part.x + part.w && pos.y > part.y && pos.y < part.y + part.h) {
                        return { region, part, partIndex: j, vertex: null, vertexIndex: -1, mode: 'body', cursor: isSelectMode || isDeleteRegionMode ? 'pointer' : 'move' };
                    }
                } else { // poly
                    for (let k = 0; k < part.points.length; k++) {
                        const p = part.points[k];
                        if (Math.hypot(pos.x - p.x, pos.y - p.y) < h2) {
                            if (isDeletePointMode) {
                                return { region, part, partIndex: j, vertex: p, vertexIndex: k, mode: 'vertex', cursor: 'crosshair' };
                            }
                            if (!isSelectMode && !isWaitingForPointClick) {
                                return { region, part, partIndex: j, vertex: p, vertexIndex: k, mode: 'vertex', cursor: 'grab' };
                            }
                        }
                    }
                    if (pointInPolygon(pos, part.points)) {
                        return { region, part, partIndex: j, vertex: null, vertexIndex: -1, mode: 'body', cursor: isSelectMode || isDeleteRegionMode ? 'pointer' : 'move' };
                    }
                }
            }
        }
        return { region: null, part: null, partIndex: -1, vertex: null, vertexIndex: -1, mode: null, cursor: 'default' };
    }, [regions, isSelectMode, isWaitingForPointClick, isDeletePointMode, isDeleteRegionMode, viewTransform.zoom]);
    
    
    const onMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
        if (e.button !== 0) return; // Only main button
        e.preventDefault();
    
        const canvas = canvasRef.current;
        if (!canvas) return;
        
        const pos = getCanvasPos(e, canvas, viewTransform);
        if (!pos) return;

        if (isDeleteRegionMode) {
            const hit = getHitRegion(pos);
            if (hit.region && hit.mode === 'body') {
                setRegions(prevRegions => prevRegions.filter(r => r.id !== hit.region!.id));
            }
            return;
        }

        if (isWaitingForPointClick) {
            addPointToPolygon(e);
            return;
        }

        if (isDeletePointMode) {
            const hit = getHitRegion(pos);
            if (hit.region && hit.part && hit.part.type === 'poly' && hit.vertexIndex !== -1) {
                setRegions(prevRegions => {
                    const newRegions = JSON.parse(JSON.stringify(prevRegions));
                    const regionToUpdate = newRegions.find((r: Region) => r.id === hit.region!.id);
                    if (!regionToUpdate) return prevRegions;

                    const partToUpdate = regionToUpdate.parts[hit.partIndex];
                    if (partToUpdate.type === 'poly' && partToUpdate.points.length > 3) {
                         partToUpdate.points.splice(hit.vertexIndex, 1);
                    }
                    // else: do nothing, cannot delete if it makes the poly invalid
                    return newRegions;
                });
            }
            return;
        }

        const hit = getHitRegion(pos);

        if (isSelectMode) {
            if (hit.region && hit.mode === 'body') {
                setMultiSelectRegions(prev => {
                    const newSet = new Set(prev);
                    if (newSet.has(hit.region!.id)) {
                        newSet.delete(hit.region!.id);
                    } else {
                        newSet.add(hit.region!.id);
                    }
                    return newSet;
                });
            }
            return;
        }

        if (hit.region) {
            draggingStateRef.current = {
                isDragging: true,
                selectedRegion: hit.region,
                selectedPartIndex: hit.partIndex,
                selectedVertexIndex: hit.vertexIndex,
                dragMode: hit.mode,
                mouseOffset: { x: pos.x, y: pos.y },
            };
            setCursor(hit.cursor);

            // Bring to top
            setRegions(prev => [...prev.filter(r => r.id !== hit.region!.id), hit.region!]);
            
            if (multiSelectRegions.size > 0) {
                setMultiSelectRegions(new Set());
            }
        }
    };
    
    const onMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const { isDragging, dragMode } = draggingStateRef.current;
        
        const pos = getCanvasPos(e, canvas, viewTransform);
        if (!pos) return;
        
        if (isDragging && dragMode) {
            const clampX = (x: number) => Math.max(0, Math.min(x, originalImage?.naturalWidth ?? Infinity));
            const clampY = (y: number) => Math.max(0, Math.min(y, originalImage?.naturalHeight ?? Infinity));

            setRegions(prevRegions => {
                const { selectedRegion, selectedPartIndex, selectedVertexIndex, mouseOffset } = draggingStateRef.current;
                if (!selectedRegion) return prevRegions;
                
                const regionIndex = prevRegions.findIndex(r => r.id === selectedRegion.id);
                if (regionIndex === -1) return prevRegions;

                const newRegions = [...prevRegions];
                const regionToUpdate = JSON.parse(JSON.stringify(newRegions[regionIndex]));
                const partToUpdate = regionToUpdate.parts[selectedPartIndex];

                if (dragMode === 'body') {
                    const deltaX = pos.x - mouseOffset.x;
                    const deltaY = pos.y - mouseOffset.y;
                    
                    let canMove = true;
                    // Check bounds before moving
                    for (const part of regionToUpdate.parts) {
                         if (part.type === 'rect') {
                            if (part.x + deltaX < 0 || part.y + deltaY < 0 || part.x + part.w + deltaX > originalImage!.naturalWidth || part.y + part.h + deltaY > originalImage!.naturalHeight) {
                                canMove = false; break;
                            }
                        } else {
                            for (const p of part.points) {
                                if (p.x + deltaX < 0 || p.y + deltaY < 0 || p.x + deltaX > originalImage!.naturalWidth || p.y + deltaY > originalImage!.naturalHeight) {
                                    canMove = false; break;
                                }
                            }
                        }
                        if (!canMove) break;
                    }

                    if(canMove) {
                        regionToUpdate.parts.forEach((p: Part) => {
                            if (p.type === 'rect') {
                                p.x += deltaX; p.y += deltaY;
                            } else {
                                p.points.forEach(pt => { pt.x += deltaX; pt.y += deltaY; });
                            }
                        });
                        draggingStateRef.current.mouseOffset = pos;
                    }

                } else if (partToUpdate.type === 'poly' && dragMode === 'vertex' && selectedVertexIndex !== -1) {
                    partToUpdate.points[selectedVertexIndex].x = clampX(pos.x);
                    partToUpdate.points[selectedVertexIndex].y = clampY(pos.y);
                } else if (partToUpdate.type === 'rect') {
                    const old = partToUpdate;
                    let { x, y, w, h } = old;
                    switch (dragMode) {
                        case 'n': y = clampY(pos.y); h = old.y + old.h - y; break;
                        case 'e': w = clampX(pos.x) - old.x; break;
                        case 's': h = clampY(pos.y) - old.y; break;
                        case 'w': x = clampX(pos.x); w = old.x + old.w - x; break;
                        case 'nw': x = clampX(pos.x); y = clampY(pos.y); w = old.x + old.w - x; h = old.y + old.h - y; break;
                        case 'ne': y = clampY(pos.y); w = clampX(pos.x) - old.x; h = old.y + old.h - y; break;
                        case 'se': w = clampX(pos.x) - old.x; h = clampY(pos.y) - old.y; break;
                        case 'sw': x = clampX(pos.x); w = old.x + old.w - x; h = clampY(pos.y) - old.y; break;
                    }
                    if (w < HANDLE_SIZE / viewTransform.zoom) {
                        if (dragMode === 'w' || dragMode === 'nw' || dragMode === 'sw') x = old.x + old.w - HANDLE_SIZE / viewTransform.zoom;
                        w = HANDLE_SIZE / viewTransform.zoom;
                    }
                    if (h < HANDLE_SIZE / viewTransform.zoom) {
                        if (dragMode === 'n' || dragMode === 'nw' || dragMode === 'ne') y = old.y + old.h - HANDLE_SIZE / viewTransform.zoom;
                        h = HANDLE_SIZE / viewTransform.zoom;
                    }
                    partToUpdate.x = x; partToUpdate.y = y; partToUpdate.w = w; partToUpdate.h = h;
                }
                
                newRegions[regionIndex] = regionToUpdate;
                return newRegions;
            });
        } else {
            if (isWaitingForPointClick) return;
            const hit = getHitRegion(pos);
            setCursor(hit.cursor);
        }
    };
    
    const onMouseUp = () => {
        if (draggingStateRef.current.isDragging) {
            draggingStateRef.current.isDragging = false;
        }
    };

    const handleWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
        e.preventDefault();
        const canvas = canvasRef.current;
        if (!canvas) return;

        const rect = canvas.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        const zoomFactor = 1 - e.deltaY * 0.001;
        const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, viewTransform.zoom * zoomFactor));

        const newOffsetX = mouseX - (mouseX - viewTransform.offset.x) * (newZoom / viewTransform.zoom);
        const newOffsetY = mouseY - (mouseY - viewTransform.offset.y) * (newZoom / viewTransform.zoom);

        setViewTransform({ zoom: newZoom, offset: { x: newOffsetX, y: newOffsetY } });
    };

    const zoomWithButtons = (factor: number) => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const centerX = canvas.width / 2;
        const centerY = canvas.height / 2;

        const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, viewTransform.zoom * factor));
        const newOffsetX = centerX - (centerX - viewTransform.offset.x) * (newZoom / viewTransform.zoom);
        const newOffsetY = centerY - (centerY - viewTransform.offset.y) * (newZoom / viewTransform.zoom);

        setViewTransform({ zoom: newZoom, offset: { x: newOffsetX, y: newOffsetY } });
    }
    
    const processRegions = () => {
        if (!originalImage || regions.length === 0) return;

        const results: ProcessedImage[] = [];
        const baseName = originalFileName || 'image';

        regions.forEach((region, index) => {
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            region.parts.forEach(part => {
                if (part.type === 'rect') {
                    minX = Math.min(minX, part.x);
                    minY = Math.min(minY, part.y);
                    maxX = Math.max(maxX, part.x + part.w);
                    maxY = Math.max(maxY, part.y + part.h);
                } else {
                    part.points.forEach(p => {
                        minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
                        maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
                    });
                }
            });

            const w = maxX - minX;
            const h = maxY - minY;
            if (w <= 0 || h <= 0) return;

            const tempCanvas = document.createElement('canvas');
            tempCanvas.width = w;
            tempCanvas.height = h;
            const tempCtx = tempCanvas.getContext('2d');
            if (!tempCtx) return;

            region.parts.forEach(part => {
                if (part.type === 'rect') {
                    tempCtx.fillRect(part.x - minX, part.y - minY, part.w, part.h);
                } else {
                    tempCtx.beginPath();
                    tempCtx.moveTo(part.points[0].x - minX, part.points[0].y - minY);
                    part.points.slice(1).forEach(p => tempCtx.lineTo(p.x - minX, p.y - minY));
                    tempCtx.closePath();
                    tempCtx.fill();
                }
            });

            tempCtx.globalCompositeOperation = 'source-in';
            tempCtx.drawImage(originalImage, minX, minY, w, h, 0, 0, w, h);
            results.push({ 
                id: Date.now() + index,
                name: `${baseName}_region_${index + 1}.png`, 
                dataUrl: tempCanvas.toDataURL('image/png') 
            });
        });
        setProcessedImages(results);
    };

    const deleteProcessedImage = (idToDelete: number) => {
        setProcessedImages(prev => prev.filter(img => img.id !== idToDelete));
    };

    const downloadAllAsZip = () => {
        if (processedImages.length === 0) return;
        const zip = new JSZip();
        processedImages.forEach(item => {
            const base64Data = item.dataUrl.split(',')[1];
            zip.file(item.name, base64Data, { base64: true });
        });
        const zipFileName = `cropped_${originalFileName || 'regions'}.zip`;
        zip.generateAsync({ type: 'blob' }).then((content: any) => {
            saveAs(content, zipFileName);
        });
    };
    
    const isActionDisabled = !originalImage;
    const isMergeDisabled = multiSelectRegions.size < 2 || isActionDisabled;
    const isProcessDisabled = regions.length === 0 || isActionDisabled;

    return (
        <div className="min-h-screen flex flex-col items-center p-4 md:p-8 bg-gray-900 text-gray-200">
            <div className="w-full max-w-7xl">
                <header className="text-center mb-6">
                    <h1 className="text-3xl md:text-4xl font-bold text-white">OctoCropper</h1>
                    <p className="text-gray-400 mt-2 max-w-3xl mx-auto">
                        Upload an image, define regions, modify them by adding points, and process to download.
                    </p>
                </header>

                <div className="bg-gray-800 p-4 rounded-lg shadow-xl mb-6">
                    <div className="flex flex-wrap gap-3 justify-center items-center">
                        <label htmlFor="file-input" className="cursor-pointer bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded-lg shadow-md transition-all duration-200">
                            Upload Image
                        </label>
                        <input id="file-input" ref={fileInputRef} type="file" accept="image/*" onChange={handleImageUpload} className="hidden" />

                        <button onClick={addRegion} disabled={isActionDisabled} className="bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-2 px-4 rounded-lg shadow-md transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed">
                            Add Crop Region
                        </button>
                        
                        <button onClick={startAddPointMode} disabled={isActionDisabled} className={`text-white font-bold py-2 px-4 rounded-lg shadow-md transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed ${isWaitingForPointClick ? 'bg-yellow-500 hover:bg-yellow-600' : 'bg-teal-600 hover:bg-teal-700'}`}>
                            <PlusIcon /> Add Point
                        </button>

                         <button onClick={toggleDeletePointMode} disabled={isActionDisabled} className={`text-white font-bold py-2 px-4 rounded-lg shadow-md transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed ${isDeletePointMode ? 'bg-yellow-500 hover:bg-yellow-600' : 'bg-rose-600 hover:bg-rose-700'}`}>
                            <MinusIcon /> Delete Point
                        </button>
                        
                        <div className="flex rounded-lg shadow-md">
                            <button onClick={toggleSelectMode} disabled={isActionDisabled} className={`text-white font-bold py-2 px-4 transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed rounded-l-lg ${isSelectMode ? 'bg-fuchsia-700 hover:bg-fuchsia-800' : 'bg-fuchsia-500 hover:bg-fuchsia-600'}`}>
                                Select Mode: {isSelectMode ? 'ON' : 'OFF'}
                            </button>
                            <button onClick={mergeSelectedRegions} disabled={isMergeDisabled} className="bg-fuchsia-800 hover:bg-fuchsia-900 text-white font-bold py-2 px-4 transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed rounded-r-lg border-l border-fuchsia-950">
                                Merge Selected
                            </button>
                        </div>
                        
                        <button onClick={processRegions} disabled={isProcessDisabled} className="bg-green-600 hover:bg-green-700 text-white font-bold py-2 px-4 rounded-lg shadow-md transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed">
                            Process & Download
                        </button>

                        <div className="flex rounded-lg shadow-md">
                            <button onClick={toggleDeleteRegionMode} disabled={isActionDisabled} className={`text-white font-bold py-2 px-4 transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed rounded-l-lg ${isDeleteRegionMode ? 'bg-yellow-500 hover:bg-yellow-600' : 'bg-red-600 hover:bg-red-700'}`}>
                                <TrashIcon /> Delete Region
                            </button>
                            <button onClick={clearAllRegions} disabled={isActionDisabled} className="bg-red-800 hover:bg-red-900 text-white font-bold py-2 px-4 transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed rounded-r-lg border-l border-red-950">
                                Clear All
                            </button>
                        </div>
                    </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                    <div className="md:col-span-2 bg-gray-800 p-4 rounded-lg shadow-xl relative">
                        <div ref={canvasContainerRef} className="w-full h-[60vh] min-h-[400px] flex items-center justify-center overflow-hidden bg-gray-900 rounded-md">
                            <canvas
                                ref={canvasRef}
                                style={{ cursor: cursor }}
                                onMouseDown={onMouseDown}
                                onMouseMove={onMouseMove}
                                onMouseUp={onMouseUp}
                                onMouseLeave={onMouseUp}
                                onWheel={handleWheel}
                            />
                        </div>
                        <div className="absolute bottom-6 right-6 bg-gray-700 bg-opacity-80 p-2 rounded-lg shadow-lg flex items-center space-x-2 text-white">
                            <button onClick={() => zoomWithButtons(0.8)} className="w-8 h-8 rounded-full bg-gray-600 hover:bg-gray-500">-</button>
                            <span className="w-16 text-center text-sm font-mono">{(viewTransform.zoom * 100).toFixed(0)}%</span>
                            <button onClick={() => zoomWithButtons(1.25)} className="w-8 h-8 rounded-full bg-gray-600 hover:bg-gray-500">+</button>
                            <button onClick={fitToScreen} className="px-3 h-8 rounded-md bg-gray-600 hover:bg-gray-500 text-sm">Fit</button>

                        </div>
                    </div>
                    <div className="md:col-span-1 bg-gray-800 p-4 rounded-lg shadow-xl">
                        <div className="flex justify-between items-center mb-4 border-b border-gray-600 pb-2">
                            <h2 className="text-2xl font-bold text-white">Downloads</h2>
                            {processedImages.length > 0 && (
                                <button onClick={downloadAllAsZip} className="bg-teal-600 hover:bg-teal-700 text-white font-bold py-1 px-3 rounded-lg shadow-md transition-all duration-200">
                                    Download All (.zip)
                                </button>
                            )}
                        </div>
                        <div id="output-container" className="flex flex-col gap-3 max-h-[calc(60vh-50px)] overflow-y-auto pr-2">
                           {processedImages.length === 0 ? (
                                <p className="text-gray-500">Processing results will appear here...</p>
                           ) : (
                                processedImages.map(img => (
                                    <div key={img.id} className="bg-gray-700 p-3 rounded-lg shadow-md flex flex-col gap-2">
                                        <img src={img.dataUrl} alt={img.name} className="w-full h-auto rounded-md border-2 border-gray-600" />
                                        <div className="flex gap-2">
                                            <a href={img.dataUrl} download={img.name} className="flex-grow w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded-lg text-center transition-all duration-200">
                                                Download
                                            </a>
                                            <button
                                                onClick={() => deleteProcessedImage(img.id)}
                                                className="flex-shrink-0 bg-red-600 hover:bg-red-700 text-white font-bold py-2 px-3 rounded-lg shadow-md transition-all duration-200"
                                                aria-label={`Delete ${img.name}`}
                                                title={`Delete ${img.name}`}
                                            >
                                                <TrashIcon className="mr-0" />
                                            </button>
                                        </div>
                                    </div>
                                ))
                           )}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}