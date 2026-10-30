"use client";

import { fontFamilyCss } from "@/lib/canvas/fonts";
import {
  MAX_SHAPE_TEXT,
  calloutOutlineWithTail,
  isCalloutKind,
  pointsToPath,
  shapeDetails,
  shapeRenderPoints,
} from "@/lib/canvas/shapes";
import { RichTextContent, RichTextEditor } from "./RichText";

const SHAPE_TEXT_CLASS = "max-h-full w-full overflow-hidden whitespace-pre-wrap break-words outline-none";

export function strokeDasharrayFor(strokeStyle, strokeWidth = 2) {
  if (strokeStyle === "dashed") return `${Math.max(6, strokeWidth * 4)} ${Math.max(4, strokeWidth * 2.5)}`;
  if (strokeStyle === "dotted") return `${Math.max(2, strokeWidth)} ${Math.max(3, strokeWidth * 2)}`;
  return undefined;
}

/**
 * Every shape renders as one inline SVG sized to the node's box so
 * fill/stroke/corner-radius restyle live without any raster step. Path
 * shapes (`type: "shape"`) draw their catalogue outline, and only that
 * outline takes pointer events, so clicks in the empty corners of a star
 * fall through to whatever is behind it. Any shape may hold text, centered
 * unless aligned otherwise.
 */
export function ShapeNode({ node, tailPoint, editing, readOnly, onCommit, onCancel }) {
  const { w, h, fill, stroke, strokeWidth, strokeStyle, type } = node;
  const inset = strokeWidth / 2;
  const dash = strokeDasharrayFor(strokeStyle, strokeWidth);
  const paint = {
    fill,
    stroke,
    strokeWidth,
    ...(dash ? { strokeDasharray: dash, strokeLinecap: strokeStyle === "dotted" ? "round" : "butt" } : {}),
    vectorEffect: "non-scaling-stroke",
  };
  const textStyle = { fontSize: node.fontSize ?? 16, color: node.color ?? "#ffffff", fontFamily: fontFamilyCss(node.fontFamily),
    textAlign: node.align ?? "center" };

  return (
    <>
      <svg
        viewBox={`0 0 ${Math.max(w, 1)} ${Math.max(h, 1)}`}
        className="h-full w-full overflow-visible"
        preserveAspectRatio="none"
      >
        {type === "rect" && (
          <rect
            x={inset}
            y={inset}
            width={Math.max(w - strokeWidth, 0)}
            height={Math.max(h - strokeWidth, 0)}
            rx={node.cornerRadius ?? 0}
            ry={node.cornerRadius ?? 0}
            {...paint}
          />
        )}
        {type === "ellipse" && (
          <ellipse
            cx={w / 2}
            cy={h / 2}
            rx={Math.max(w / 2 - inset, 0)}
            ry={Math.max(h / 2 - inset, 0)}
            {...paint}
          />
        )}
        {type === "triangle" && (
          <polygon
            points={`${w / 2},${inset} ${w - inset},${h - inset} ${inset},${h - inset}`}
            strokeLinejoin="round"
            {...paint}
          />
        )}
        {type === "diamond" && (
          <polygon
            points={`${w / 2},${inset} ${w - inset},${h / 2} ${w / 2},${h - inset} ${inset},${h / 2}`}
            strokeLinejoin="round"
            {...paint}
          />
        )}
        {type === "shape" && <PathShape node={node} tailPoint={tailPoint} inset={inset} paint={paint} />}
      </svg>

      {(editing || node.text) && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-[12%] py-[10%]">
          {editing ? (
            <RichTextEditor
              text={node.text ?? ""}
              marks={node.marks}
              onCommit={onCommit}
              onCancel={onCancel}
              maxLength={MAX_SHAPE_TEXT}
              className={`${SHAPE_TEXT_CLASS} pointer-events-auto min-h-[1.25em]`}
              style={{ ...textStyle, cursor: "text" }}
            />
          ) : (
            <div className={SHAPE_TEXT_CLASS} style={textStyle}>
              <RichTextContent text={node.text} marks={node.marks} openLinks={readOnly} />
            </div>
          )}
        </div>
      )}
    </>
  );
}

function PathShape({ node, tailPoint, inset, paint }) {
  const { w, h, shape, svg, svgViewBox } = node;
  if (svg && typeof shape === "string" && shape.startsWith("custom:")) {
    return (
      <>
        <rect
          data-shape-outline={shape}
          x={inset}
          y={inset}
          width={Math.max(w - inset * 2, 0)}
          height={Math.max(h - inset * 2, 0)}
          rx={node.cornerRadius ?? 4}
          ry={node.cornerRadius ?? 4}
          pointerEvents="all"
          {...paint}
        />
        <svg
          viewBox={svgViewBox || "0 0 100 100"}
          x={inset + w * 0.08}
          y={inset + h * 0.08}
          width={Math.max(w * 0.84 - inset * 2, 1)}
          height={Math.max(h * 0.84 - inset * 2, 1)}
          fill="none"
          stroke={paint.stroke}
          strokeWidth={paint.strokeWidth}
          pointerEvents="none"
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </>
    );
  }

  const innerW = Math.max(w - inset * 2, 0);
  const innerH = Math.max(h - inset * 2, 0);
  const details = shapeDetails(shape, innerW, innerH);
  const outlinePoints =
    isCalloutKind(shape) && tailPoint
      ? calloutOutlineWithTail(shape, innerW, innerH, {
          x: tailPoint.x - node.x - inset,
          y: tailPoint.y - node.y - inset,
        }).map(([x, y]) => [x + inset, y + inset])
      : shapeRenderPoints(shape, w, h, inset);

  return (
    <>
      <path
        data-shape-outline={shape}
        d={pointsToPath(outlinePoints)}
        strokeLinejoin="round"
        pointerEvents="all"
        {...paint}
      />
      {details.map((detail, idx) => (
        <path
          key={idx}
          d={pointsToPath(detail.map(([x, y]) => [x + inset, y + inset]), false)}
          fill="none"
          stroke={paint.stroke}
          strokeWidth={paint.strokeWidth}
          strokeDasharray={paint.strokeDasharray}
          vectorEffect="non-scaling-stroke"
          pointerEvents="none"
        />
      ))}
    </>
  );
}
