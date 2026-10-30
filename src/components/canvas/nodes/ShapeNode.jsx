"use client";

import { pointsToPath, shapeDetail, shapeRenderPoints, textColorOf } from "@/lib/canvas/shapes";
import { RichTextContent, RichTextEditor } from "./RichText";

const SHAPE_TEXT_CLASS = "max-h-full w-full overflow-hidden whitespace-pre-wrap break-words text-center outline-none";

/**
 * Every shape renders as one inline SVG sized to the node's box so
 * fill/stroke/corner-radius restyle live without any raster step. Path
 * shapes (`type: "shape"`) draw their catalogue outline, and only that
 * outline takes pointer events, so clicks in the empty corners of a star
 * fall through to whatever is behind it. Any shape may hold centered text.
 */
export function ShapeNode({ node, editing, readOnly, onCommit, onCancel }) {
  const { w, h, fill, stroke, strokeWidth, type } = node;
  const inset = strokeWidth / 2;
  const paint = { fill, stroke, strokeWidth, vectorEffect: "non-scaling-stroke" };
  const textStyle = { fontSize: node.fontSize ?? 16, color: textColorOf(node) };

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
        {type === "shape" && <PathShape node={node} inset={inset} paint={paint} />}
      </svg>

      {(editing || node.text) && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-[12%] py-[10%]">
          {editing ? (
            <RichTextEditor
              text={node.text ?? ""}
              marks={node.marks}
              onCommit={onCommit}
              onCancel={onCancel}
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

function PathShape({ node, inset, paint }) {
  const { w, h, shape } = node;
  const detail = shapeDetail(shape, Math.max(w - inset * 2, 0), Math.max(h - inset * 2, 0));
  return (
    <>
      <path
        data-shape-outline={shape}
        d={pointsToPath(shapeRenderPoints(shape, w, h, inset))}
        strokeLinejoin="round"
        pointerEvents="all"
        {...paint}
      />
      {detail && (
        <path
          d={pointsToPath(detail.map(([x, y]) => [x + inset, y + inset]), false)}
          fill="none"
          stroke={paint.stroke}
          strokeWidth={paint.strokeWidth}
          vectorEffect="non-scaling-stroke"
          pointerEvents="none"
        />
      )}
    </>
  );
}
