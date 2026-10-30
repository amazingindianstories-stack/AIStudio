/**
 * Extended diagramming shape packs and pack metadata.
 *
 * Licences and provenance:
 * - Flowchart, Callouts, UML, BPMN, DFD, VSM, Electrical Engineering and
 *   Process Engineering symbols are standard notation geometry authored in
 *   this repository under the project's licence.
 * - Cloud and Infrastructure icons combine CNCF Kubernetes community icon
 *   geometry (https://github.com/kubernetes/community/tree/master/icons,
 *   licensed under CC-BY-4.0 / Apache-2.0, attribution: The Kubernetes
 *   Authors / Linux Foundation) with generic infrastructure architecture
 *   symbols modeled on Lucide (https://lucide.dev, ISC License).
 *   Proprietary vendor logos whose brand terms restrict redistribution
 *   are intentionally omitted; users can upload custom SVGs via Custom
 *   shape packs.
 */

const STEPS = 18;

function arcPoints(cx, cy, rx, ry, from, to, steps = STEPS) {
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const a = from + ((to - from) * i) / steps;
    pts.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]);
  }
  return pts;
}

function circleOutline(w, h, steps = 24) {
  const pts = [];
  for (let i = 0; i < steps; i++) {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / steps;
    pts.push([w / 2 + Math.cos(a) * (w / 2), h / 2 + Math.sin(a) * (h / 2)]);
  }
  return pts;
}

function stadiumOutline(w, h) {
  const r = Math.min(w, h) / 2;
  return [
    ...arcPoints(w - r, h / 2, r, h / 2, -Math.PI / 2, Math.PI / 2, 12),
    ...arcPoints(r, h / 2, r, h / 2, Math.PI / 2, Math.PI * 1.5, 12),
  ];
}

function wavyBottomRect(w, h) {
  const waveH = Math.min(h * 0.14, 18);
  const base = h - waveH;
  const pts = [[0, 0], [w, 0], [w, base]];
  const steps = 16;
  for (let i = 1; i <= steps; i++) {
    const t = 1 - i / steps;
    const y = base + Math.sin(t * Math.PI * 2) * waveH * 0.85;
    pts.push([t * w, y]);
  }
  return pts;
}

function dogEarRect(w, h, foldRatio = 0.2) {
  const f = Math.min(w, h) * foldRatio;
  return [[0, 0], [w - f, 0], [w, f], [w, h], [0, h]];
}

function roundedBox(w, h, rRatio = 0.14) {
  const r = Math.min(w, h) * rRatio;
  return [
    ...arcPoints(w - r, r, r, r, -Math.PI / 2, 0, 5),
    ...arcPoints(w - r, h - r, r, r, 0, Math.PI / 2, 5),
    ...arcPoints(r, h - r, r, r, Math.PI / 2, Math.PI, 5),
    ...arcPoints(r, r, r, r, Math.PI, Math.PI * 1.5, 5),
  ];
}

function diamondOutline(w, h) {
  return [[w / 2, 0], [w, h / 2], [w / 2, h], [0, h / 2]];
}

function heptagonOutline(w, h) {
  const pts = [];
  for (let i = 0; i < 7; i++) {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / 7;
    pts.push([w / 2 + Math.cos(a) * (w * 0.48), h / 2 + Math.sin(a) * (h * 0.48)]);
  }
  return pts;
}

/**
 * Outline builders for every extended pack shape kind.
 */
export const PACK_OUTLINES = {
  // Flowchart pack
  "fc-process": (w, h) => [[0, 0], [w, 0], [w, h], [0, h]],
  "fc-decision": (w, h) => diamondOutline(w, h),
  "fc-terminator": (w, h) => stadiumOutline(w, h),
  "fc-data": (w, h) => {
    const s = Math.min(w * 0.2, h * 0.5);
    return [[s, 0], [w, 0], [w - s, h], [0, h]];
  },
  "fc-document": (w, h) => wavyBottomRect(w, h),
  "fc-multi-document": (w, h) => {
    const ox = w * 0.1;
    const oy = h * 0.12;
    return wavyBottomRect(w - ox, h - oy).map(([x, y]) => [x, y + oy]);
  },
  "fc-database": (w, h) => {
    const ry = Math.min(h * 0.15, w * 0.3);
    return [
      ...arcPoints(w / 2, ry, w / 2, ry, Math.PI, Math.PI * 2, 14),
      ...arcPoints(w / 2, h - ry, w / 2, ry, 0, Math.PI, 14),
    ];
  },
  "fc-predefined": (w, h) => [[0, 0], [w, 0], [w, h], [0, h]],
  "fc-internal-storage": (w, h) => [[0, 0], [w, 0], [w, h], [0, h]],
  "fc-manual-input": (w, h) => [[0, h * 0.24], [w, 0], [w, h], [0, h]],
  "fc-manual-operation": (w, h) => {
    const s = Math.min(w * 0.2, h * 0.5);
    return [[0, 0], [w, 0], [w - s, h], [s, h]];
  },
  "fc-preparation": (w, h) => {
    const s = Math.min(w * 0.22, h * 0.5);
    return [[s, 0], [w - s, 0], [w, h / 2], [w - s, h], [s, h], [0, h / 2]];
  },
  "fc-delay": (w, h) => [
    [0, 0],
    [w * 0.55, 0],
    ...arcPoints(w * 0.55, h / 2, w * 0.45, h / 2, -Math.PI / 2, Math.PI / 2, 14),
    [0, h],
  ],
  "fc-stored-data": (w, h) => {
    const rx = w * 0.18;
    return [
      ...arcPoints(rx, h / 2, rx, h / 2, Math.PI * 1.5, Math.PI * 0.5, 12).reverse(),
      ...arcPoints(w, h / 2, rx, h / 2, Math.PI * 0.5, Math.PI * 1.5, 12),
    ];
  },
  "fc-merge": (w, h) => [[0, 0], [w, 0], [w / 2, h]],
  "fc-extract": (w, h) => [[w / 2, 0], [w, h], [0, h]],
  "fc-or": (w, h) => circleOutline(w, h),
  "fc-summing": (w, h) => circleOutline(w, h),
  "fc-display": (w, h) => [
    [0, h / 2],
    [w * 0.25, 0],
    [w * 0.65, 0],
    ...arcPoints(w * 0.65, h / 2, w * 0.35, h / 2, -Math.PI / 2, Math.PI / 2, 12),
    [w * 0.25, h],
  ],
  "fc-off-page": (w, h) => [[0, 0], [w, 0], [w, h * 0.68], [w / 2, h], [0, h * 0.68]],
  "fc-card": (w, h) => {
    const c = Math.min(w, h) * 0.22;
    return [[c, 0], [w, 0], [w, h], [0, h], [0, c]];
  },

  // Callouts pack
  "callout-rect": (w, h) => {
    const body = h * 0.78;
    return [[0, 0], [w, 0], [w, body], [w * 0.44, body], [w * 0.22, h], [w * 0.26, body], [0, body]];
  },
  "callout-oval": (w, h) => {
    const body = h * 0.8;
    const rx = w / 2;
    const ry = body / 2;
    const pts = [];
    const steps = 28;
    for (let i = 0; i < steps; i++) {
      const a = -Math.PI / 2 + (i * 2 * Math.PI) / steps;
      pts.push([rx + Math.cos(a) * rx, ry + Math.sin(a) * ry]);
      if (i === Math.floor(steps * 0.56)) {
        pts.push([w * 0.2, h]);
      }
    }
    return pts;
  },
  "callout-bracket": (w, h) => {
    const body = h * 0.82;
    return [[w * 0.25, 0], [0, 0], [0, body], [w * 0.25, body], [w * 0.12, h], [w * 0.35, body], [w, body], [w, 0]];
  },

  // UML pack
  "uml-class": (w, h) => [[0, 0], [w, 0], [w, h], [0, h]],
  "uml-interface": (w, h) => [[0, 0], [w, 0], [w, h], [0, h]],
  "uml-package": (w, h) => {
    const tabH = Math.min(h * 0.2, 24);
    const tabW = w * 0.42;
    return [[0, 0], [tabW, 0], [tabW + tabH * 0.3, tabH], [w, tabH], [w, h], [0, h]];
  },
  "uml-component": (w, h) => [[w * 0.08, 0], [w, 0], [w, h], [w * 0.08, h]],
  "uml-node": (w, h) => {
    const d = Math.min(w, h) * 0.18;
    return [[d, 0], [w, 0], [w, h - d], [w - d, h], [0, h], [0, d]];
  },
  "uml-actor": (w, h) => circleOutline(w, h),
  "uml-use-case": (w, h) => circleOutline(w, h, 28),
  "uml-note": (w, h) => dogEarRect(w, h, 0.2),
  "uml-state": (w, h) => roundedBox(w, h, 0.18),
  "uml-initial-state": (w, h) => circleOutline(w, h),
  "uml-lifeline": (w, h) => [[0, 0], [w, 0], [w, h * 0.28], [0, h * 0.28]],
  "uml-fork-join": (w, h) => roundedBox(w, h, 0.2),

  // BPMN pack
  "bpmn-task": (w, h) => roundedBox(w, h, 0.14),
  "bpmn-subprocess": (w, h) => roundedBox(w, h, 0.14),
  "bpmn-start-event": (w, h) => circleOutline(w, h),
  "bpmn-intermediate-event": (w, h) => circleOutline(w, h),
  "bpmn-end-event": (w, h) => circleOutline(w, h),
  "bpmn-gateway-exclusive": (w, h) => diamondOutline(w, h),
  "bpmn-gateway-parallel": (w, h) => diamondOutline(w, h),
  "bpmn-gateway-inclusive": (w, h) => diamondOutline(w, h),
  "bpmn-data-object": (w, h) => dogEarRect(w, h, 0.22),
  "bpmn-data-store": (w, h) => PACK_OUTLINES["fc-database"](w, h),
  "bpmn-message": (w, h) => [[0, 0], [w, 0], [w, h], [0, h]],
  "bpmn-annotation": (w, h) => [[0, 0], [w, 0], [w, h], [0, h]],

  // DFD pack
  "dfd-entity": (w, h) => [[0, 0], [w, 0], [w, h], [0, h]],
  "dfd-process": (w, h) => roundedBox(w, h, 0.16),
  "dfd-process-circle": (w, h) => circleOutline(w, h),
  "dfd-data-store": (w, h) => [[0, 0], [w, 0], [w, h], [0, h]],
  "dfd-multi-process": (w, h) => roundedBox(w * 0.9, h * 0.9, 0.16).map(([x, y]) => [x, y + h * 0.1]),

  // VSM pack
  "vsm-process": (w, h) => [[0, 0], [w, 0], [w, h], [0, h]],
  "vsm-customer-supplier": (w, h) => {
    const roof = h * 0.26;
    return [
      [0, roof],
      [w / 3, 0],
      [w / 3, roof],
      [(2 * w) / 3, 0],
      [(2 * w) / 3, roof],
      [w, 0],
      [w, h],
      [0, h],
    ];
  },
  "vsm-inventory": (w, h) => [[w / 2, 0], [w, h], [0, h]],
  "vsm-supermarket": (w, h) => [[0, 0], [w, 0], [w, h], [0, h]],
  "vsm-kaizen": (w, h) => {
    const pts = [];
    const spikes = 10;
    for (let i = 0; i < spikes * 2; i++) {
      const a = (i * Math.PI) / spikes;
      const r = i % 2 === 0 ? 0.5 : 0.33;
      pts.push([w * (0.5 + Math.cos(a) * r), h * (0.5 + Math.sin(a) * r)]);
    }
    return pts;
  },
  "vsm-fifo": (w, h) => [[0, 0], [w, 0], [w, h], [0, h]],
  "vsm-shipment": (w, h) => [
    [0, h * 0.15],
    [w * 0.68, h * 0.15],
    [w * 0.68, h * 0.35],
    [w * 0.92, h * 0.35],
    [w, h * 0.58],
    [w, h * 0.82],
    [0, h * 0.82],
  ],
  "vsm-push": (w, h) => {
    const head = Math.min(w * 0.35, h * 0.8);
    return [[0, h * 0.24], [w - head, h * 0.24], [w - head, 0], [w, h / 2], [w - head, h], [w - head, h * 0.76], [0, h * 0.76]];
  },
  "vsm-operator": (w, h) => circleOutline(w, h),

  // Cloud and Infrastructure pack (Kubernetes CC-BY-4.0 / Apache-2.0 + generic MIT/ISC infrastructure)
  "k8s-wheel": (w, h) => heptagonOutline(w, h),
  "k8s-pod": (w, h) => heptagonOutline(w, h),
  "k8s-service": (w, h) => heptagonOutline(w, h),
  "k8s-deployment": (w, h) => heptagonOutline(w, h),
  "k8s-ingress": (w, h) => heptagonOutline(w, h),
  "k8s-node": (w, h) => heptagonOutline(w, h),
  "k8s-pvc": (w, h) => heptagonOutline(w, h),
  "infra-cloud": (w, h) => roundedBox(w, h, 0.18),
  "infra-server": (w, h) => roundedBox(w, h, 0.12),
  "infra-container": (w, h) => roundedBox(w, h, 0.12),
  "infra-serverless": (w, h) => roundedBox(w, h, 0.16),
  "infra-database": (w, h) => PACK_OUTLINES["fc-database"](w, h),
  "infra-storage": (w, h) => [[w * 0.08, 0], [w * 0.92, 0], [w * 0.82, h], [w * 0.18, h]],
  "infra-load-balancer": (w, h) => roundedBox(w, h, 0.16),
  "infra-cdn": (w, h) => circleOutline(w, h),
  "infra-firewall": (w, h) => [
    [w / 2, 0],
    [w, h * 0.2],
    [w, h * 0.58],
    [w / 2, h],
    [0, h * 0.58],
    [0, h * 0.2],
  ],
  "infra-vpc": (w, h) => roundedBox(w, h, 0.1),
  "infra-queue": (w, h) => stadiumOutline(w, h),
  "infra-router": (w, h) => circleOutline(w, h),

  // Electrical Engineering pack
  "ee-resistor": (w, h) => [[0, 0], [w, 0], [w, h], [0, h]],
  "ee-capacitor": (w, h) => [[0, 0], [w, 0], [w, h], [0, h]],
  "ee-inductor": (w, h) => [[0, 0], [w, 0], [w, h], [0, h]],
  "ee-diode": (w, h) => circleOutline(w, h),
  "ee-ground": (w, h) => [[0, 0], [w, 0], [w, h], [0, h]],
  "ee-dc-source": (w, h) => circleOutline(w, h),
  "ee-ac-source": (w, h) => circleOutline(w, h),
  "ee-switch": (w, h) => [[0, 0], [w, 0], [w, h], [0, h]],
  "ee-transistor": (w, h) => circleOutline(w, h),
  "ee-op-amp": (w, h) => [[0, 0], [w, h / 2], [0, h]],
  "ee-and-gate": (w, h) => [
    [0, 0],
    [w * 0.5, 0],
    ...arcPoints(w * 0.5, h / 2, w * 0.5, h / 2, -Math.PI / 2, Math.PI / 2, 14),
    [0, h],
  ],
  "ee-or-gate": (w, h) => [
    [0, 0],
    [w * 0.45, 0],
    [w, h / 2],
    [w * 0.45, h],
    [0, h],
    [w * 0.18, h / 2],
  ],

  // Process Engineering pack
  "pe-valve": (w, h) => [[0, h * 0.15], [w, h * 0.85], [w, h * 0.15], [0, h * 0.85]],
  "pe-control-valve": (w, h) => [[0, h * 0.35], [w, h * 0.9], [w, h * 0.35], [0, h * 0.9]],
  "pe-pump": (w, h) => circleOutline(w, h),
  "pe-compressor": (w, h) => [[0, 0], [w, h * 0.2], [w, h * 0.8], [0, h]],
  "pe-heat-exchanger": (w, h) => circleOutline(w, h),
  "pe-vessel": (w, h) => [
    ...arcPoints(w / 2, h * 0.18, w / 2, h * 0.18, Math.PI, Math.PI * 2, 12),
    ...arcPoints(w / 2, h * 0.82, w / 2, h * 0.18, 0, Math.PI, 12),
  ],
  "pe-reactor": (w, h) => [
    ...arcPoints(w / 2, h * 0.18, w / 2, h * 0.18, Math.PI, Math.PI * 2, 12),
    ...arcPoints(w / 2, h * 0.82, w / 2, h * 0.18, 0, Math.PI, 12),
  ],
  "pe-filter": (w, h) => diamondOutline(w, h),
  "pe-mixer": (w, h) => [[0, 0], [w, 0], [w, h], [0, h]],
  "pe-column": (w, h) => [
    ...arcPoints(w / 2, h * 0.12, w / 2, h * 0.12, Math.PI, Math.PI * 2, 12),
    ...arcPoints(w / 2, h * 0.88, w / 2, h * 0.12, 0, Math.PI, 12),
  ],
};

/**
 * Interior detail polylines (each entry is an array of [x, y] points) drawn
 * inside a shape's bounding box.
 */
export const PACK_DETAILS = {
  "fc-database": (w, h) => {
    const ry = Math.min(h * 0.15, w * 0.3);
    return [arcPoints(w / 2, ry, w / 2, ry, Math.PI, 0, 14)];
  },
  "fc-multi-document": (w, h) => {
    const ox = w * 0.05;
    const oy = h * 0.06;
    return [
      [[ox, oy], [w - ox, oy], [w - ox, h * 0.78]],
      [[ox * 2, 0], [w, 0], [w, h * 0.72]],
    ];
  },
  "fc-predefined": (w, h) => [
    [[w * 0.14, 0], [w * 0.14, h]],
    [[w * 0.86, 0], [w * 0.86, h]],
  ],
  "fc-internal-storage": (w, h) => [
    [[0, h * 0.22], [w, h * 0.22]],
    [[w * 0.22, 0], [w * 0.22, h]],
  ],
  "fc-or": (w, h) => [
    [[w / 2, 0], [w / 2, h]],
    [[0, h / 2], [w, h / 2]],
  ],
  "fc-summing": (w, h) => {
    const d = 0.5 * (1 - Math.SQRT1_2);
    return [
      [[w * d, h * d], [w * (1 - d), h * (1 - d)]],
      [[w * (1 - d), h * d], [w * d, h * (1 - d)]],
    ];
  },
  "uml-class": (w, h) => [
    [[0, h * 0.28], [w, h * 0.28]],
    [[0, h * 0.64], [w, h * 0.64]],
  ],
  "uml-interface": (w, h) => [
    [[0, h * 0.32], [w, h * 0.32]],
    arcPoints(w / 2, h * 0.16, Math.min(w, h) * 0.08, Math.min(w, h) * 0.08, 0, Math.PI * 2, 12),
  ],
  "uml-package": (w, h) => {
    const tabH = Math.min(h * 0.2, 24);
    return [[[0, tabH], [w * 0.45, tabH]]];
  },
  "uml-component": (w, h) => [
    [[0, h * 0.22], [w * 0.18, h * 0.22], [w * 0.18, h * 0.38], [0, h * 0.38], [0, h * 0.22]],
    [[0, h * 0.56], [w * 0.18, h * 0.56], [w * 0.18, h * 0.72], [0, h * 0.72], [0, h * 0.56]],
  ],
  "uml-node": (w, h) => {
    const d = Math.min(w, h) * 0.18;
    return [
      [[0, d], [w - d, d], [w, 0]],
      [[w - d, d], [w - d, h]],
    ];
  },
  "uml-actor": (w, h) => [
    arcPoints(w / 2, h * 0.24, w * 0.12, h * 0.12, 0, Math.PI * 2, 12),
    [[w / 2, h * 0.36], [w / 2, h * 0.66]],
    [[w * 0.24, h * 0.48], [w * 0.76, h * 0.48]],
    [[w * 0.3, h * 0.88], [w / 2, h * 0.66], [w * 0.7, h * 0.88]],
  ],
  "uml-note": (w, h) => {
    const f = Math.min(w, h) * 0.2;
    return [[[w - f, 0], [w - f, f], [w, f]]];
  },
  "uml-state": (w, h) => [[[0, h * 0.32], [w, h * 0.32]]],
  "uml-lifeline": (w, h) => [
    [[w / 2, h * 0.28], [w / 2, h]],
  ],
  "bpmn-subprocess": (w, h) => {
    const s = Math.min(w, h) * 0.18;
    const x0 = (w - s) / 2;
    const y0 = h - s - 4;
    return [
      [[x0, y0], [x0 + s, y0], [x0 + s, y0 + s], [x0, y0 + s], [x0, y0]],
      [[w / 2, y0 + s * 0.2], [w / 2, y0 + s * 0.8]],
      [[x0 + s * 0.2, y0 + s / 2], [x0 + s * 0.8, y0 + s / 2]],
    ];
  },
  "bpmn-intermediate-event": (w, h) => [
    arcPoints(w / 2, h / 2, w * 0.38, h * 0.38, 0, Math.PI * 2, 20),
  ],
  "bpmn-end-event": (w, h) => [
    arcPoints(w / 2, h / 2, w * 0.43, h * 0.43, 0, Math.PI * 2, 20),
  ],
  "bpmn-gateway-exclusive": (w, h) => [
    [[w * 0.36, h * 0.36], [w * 0.64, h * 0.64]],
    [[w * 0.64, h * 0.36], [w * 0.36, h * 0.64]],
  ],
  "bpmn-gateway-parallel": (w, h) => [
    [[w / 2, h * 0.28], [w / 2, h * 0.72]],
    [[w * 0.28, h / 2], [w * 0.72, h / 2]],
  ],
  "bpmn-gateway-inclusive": (w, h) => [
    arcPoints(w / 2, h / 2, w * 0.22, h * 0.22, 0, Math.PI * 2, 16),
  ],
  "bpmn-data-object": (w, h) => {
    const f = Math.min(w, h) * 0.22;
    return [[[w - f, 0], [w - f, f], [w, f]]];
  },
  "bpmn-data-store": (w, h) => {
    const ry = Math.min(h * 0.15, w * 0.3);
    return [
      arcPoints(w / 2, ry, w / 2, ry, Math.PI, 0, 14),
      arcPoints(w / 2, ry * 1.7, w / 2, ry, Math.PI, 0, 14),
    ];
  },
  "bpmn-message": (w, h) => [
    [[0, 0], [w / 2, h * 0.55], [w, 0]],
  ],
  "bpmn-annotation": (w, h) => [
    [[w * 0.35, 0], [0, 0], [0, h], [w * 0.35, h]],
  ],
  "dfd-process": (w, h) => [[[0, h * 0.26], [w, h * 0.26]]],
  "dfd-data-store": (w, h) => [[[w * 0.18, 0], [w * 0.18, h]]],
  "dfd-multi-process": (w, h) => [
    [[w * 0.1, 0], [w, 0], [w, h * 0.9]],
  ],
  "vsm-process": (w, h) => [
    [[0, h * 0.28], [w, h * 0.28]],
    [[0, h * 0.72], [w, h * 0.72]],
  ],
  "vsm-inventory": (w, h) => [
    [[w / 2, h * 0.42], [w / 2, h * 0.82]],
    [[w * 0.38, h * 0.42], [w * 0.62, h * 0.42]],
    [[w * 0.38, h * 0.82], [w * 0.62, h * 0.82]],
  ],
  "vsm-supermarket": (w, h) => [
    [[0, h * 0.33], [w, h * 0.33]],
    [[0, h * 0.66], [w, h * 0.66]],
  ],
  "vsm-fifo": (w, h) => [
    [[w * 0.12, h / 2], [w * 0.86, h / 2]],
    [[w * 0.72, h * 0.3], [w * 0.88, h / 2], [w * 0.72, h * 0.7]],
  ],
  "vsm-shipment": (w, h) => [
    arcPoints(w * 0.24, h * 0.82, w * 0.1, h * 0.12, 0, Math.PI * 2, 10),
    arcPoints(w * 0.76, h * 0.82, w * 0.1, h * 0.12, 0, Math.PI * 2, 10),
  ],
  "vsm-push": (w, h) => [
    [[w * 0.2, h * 0.24], [w * 0.2, h * 0.76]],
    [[w * 0.4, h * 0.24], [w * 0.4, h * 0.76]],
  ],
  "vsm-operator": (w, h) => [
    arcPoints(w / 2, h * 0.38, w * 0.18, h * 0.18, 0, Math.PI * 2, 12),
    arcPoints(w / 2, h * 0.82, w * 0.3, h * 0.22, Math.PI, Math.PI * 2, 10),
  ],

  // Cloud and Infrastructure details
  "k8s-wheel": (w, h) => [
    arcPoints(w / 2, h / 2, w * 0.24, h * 0.24, 0, Math.PI * 2, 16),
    [[w / 2, h * 0.16], [w / 2, h * 0.84]],
    [[w * 0.18, h / 2], [w * 0.82, h / 2]],
  ],
  "k8s-pod": (w, h) => [
    [[w * 0.3, h * 0.34], [w * 0.7, h * 0.34], [w * 0.7, h * 0.68], [w * 0.3, h * 0.68], [w * 0.3, h * 0.34]],
  ],
  "k8s-service": (w, h) => [
    [[w * 0.25, h / 2], [w * 0.75, h / 2]],
    [[w / 2, h * 0.26], [w * 0.75, h / 2], [w / 2, h * 0.74]],
  ],
  "k8s-deployment": (w, h) => [
    arcPoints(w / 2, h / 2, w * 0.24, h * 0.24, -Math.PI * 0.7, Math.PI * 0.8, 12),
  ],
  "k8s-ingress": (w, h) => [
    [[w * 0.22, h / 2], [w * 0.65, h / 2]],
    [[w * 0.5, h * 0.34], [w * 0.68, h / 2], [w * 0.5, h * 0.66]],
    [[w * 0.74, h * 0.28], [w * 0.74, h * 0.72]],
  ],
  "k8s-node": (w, h) => [
    [[w * 0.28, h * 0.32], [w * 0.72, h * 0.32], [w * 0.72, h * 0.68], [w * 0.28, h * 0.68], [w * 0.28, h * 0.32]],
    [[w * 0.28, h / 2], [w * 0.72, h / 2]],
  ],
  "k8s-pvc": (w, h) => [
    arcPoints(w / 2, h * 0.38, w * 0.22, h * 0.08, 0, Math.PI * 2, 12),
    [[w * 0.28, h * 0.38], [w * 0.28, h * 0.66]],
    [[w * 0.72, h * 0.38], [w * 0.72, h * 0.66]],
    arcPoints(w / 2, h * 0.66, w * 0.22, h * 0.08, 0, Math.PI, 8),
  ],
  "infra-cloud": (w, h) => [
    arcPoints(w * 0.38, h * 0.54, w * 0.16, h * 0.16, Math.PI * 0.7, Math.PI * 1.9, 10),
    arcPoints(w * 0.56, h * 0.48, w * 0.18, h * 0.18, Math.PI * 1.1, Math.PI * 2.3, 10),
    [[w * 0.24, h * 0.66], [w * 0.76, h * 0.66]],
  ],
  "infra-server": (w, h) => [
    [[0, h * 0.33], [w, h * 0.33]],
    [[0, h * 0.66], [w, h * 0.66]],
    [[w * 0.14, h * 0.16], [w * 0.22, h * 0.16]],
    [[w * 0.14, h * 0.5], [w * 0.22, h * 0.5]],
    [[w * 0.14, h * 0.82], [w * 0.22, h * 0.82]],
  ],
  "infra-container": (w, h) => [
    [[w * 0.25, h * 0.2], [w * 0.25, h * 0.8]],
    [[w * 0.5, h * 0.2], [w * 0.5, h * 0.8]],
    [[w * 0.75, h * 0.2], [w * 0.75, h * 0.8]],
  ],
  "infra-serverless": (w, h) => [
    [[w * 0.56, h * 0.18], [w * 0.34, h * 0.52], [w * 0.54, h * 0.52], [w * 0.42, h * 0.84]],
  ],
  "infra-database": (w, h) => PACK_DETAILS["bpmn-data-store"](w, h),
  "infra-storage": (w, h) => [
    [[w * 0.08, h * 0.2], [w * 0.92, h * 0.2]],
  ],
  "infra-load-balancer": (w, h) => [
    [[w * 0.2, h / 2], [w * 0.5, h / 2]],
    [[w * 0.5, h / 2], [w * 0.78, h * 0.25]],
    [[w * 0.5, h / 2], [w * 0.78, h / 2]],
    [[w * 0.5, h / 2], [w * 0.78, h * 0.75]],
  ],
  "infra-cdn": (w, h) => [
    [[0, h / 2], [w, h / 2]],
    [[w / 2, 0], [w / 2, h]],
    arcPoints(w / 2, h / 2, w * 0.26, h / 2, 0, Math.PI * 2, 16),
  ],
  "infra-firewall": (w, h) => [
    [[w / 2, h * 0.2], [w / 2, h * 0.8]],
    [[w * 0.22, h * 0.45], [w * 0.78, h * 0.45]],
  ],
  "infra-vpc": (w, h) => [
    [[w * 0.14, h * 0.14], [w * 0.86, h * 0.14], [w * 0.86, h * 0.86], [w * 0.14, h * 0.86], [w * 0.14, h * 0.14]],
  ],
  "infra-queue": (w, h) => [
    [[w * 0.32, h * 0.22], [w * 0.32, h * 0.78]],
    [[w * 0.5, h * 0.22], [w * 0.5, h * 0.78]],
    [[w * 0.68, h * 0.22], [w * 0.68, h * 0.78]],
  ],
  "infra-router": (w, h) => [
    [[w * 0.2, h / 2], [w * 0.8, h / 2]],
    [[w / 2, h * 0.2], [w / 2, h * 0.8]],
  ],

  // Electrical Engineering details
  "ee-resistor": (w, h) => [
    [
      [0, h / 2],
      [w * 0.16, h / 2],
      [w * 0.24, h * 0.2],
      [w * 0.36, h * 0.8],
      [w * 0.48, h * 0.2],
      [w * 0.6, h * 0.8],
      [w * 0.72, h * 0.2],
      [w * 0.82, h / 2],
      [w, h / 2],
    ],
  ],
  "ee-capacitor": (w, h) => [
    [[0, h / 2], [w * 0.42, h / 2]],
    [[w * 0.42, h * 0.18], [w * 0.42, h * 0.82]],
    [[w * 0.58, h * 0.18], [w * 0.58, h * 0.82]],
    [[w * 0.58, h / 2], [w, h / 2]],
  ],
  "ee-inductor": (w, h) => [
    [
      [0, h * 0.6],
      ...arcPoints(w * 0.25, h * 0.6, w * 0.12, h * 0.28, Math.PI, Math.PI * 2, 8),
      ...arcPoints(w * 0.5, h * 0.6, w * 0.12, h * 0.28, Math.PI, Math.PI * 2, 8),
      ...arcPoints(w * 0.75, h * 0.6, w * 0.12, h * 0.28, Math.PI, Math.PI * 2, 8),
      [w, h * 0.6],
    ],
  ],
  "ee-diode": (w, h) => [
    [[w * 0.15, h / 2], [w * 0.85, h / 2]],
    [[w * 0.34, h * 0.28], [w * 0.64, h / 2], [w * 0.34, h * 0.72], [w * 0.34, h * 0.28]],
    [[w * 0.64, h * 0.26], [w * 0.64, h * 0.74]],
  ],
  "ee-ground": (w, h) => [
    [[w / 2, h * 0.15], [w / 2, h * 0.52]],
    [[w * 0.2, h * 0.52], [w * 0.8, h * 0.52]],
    [[w * 0.32, h * 0.68], [w * 0.68, h * 0.68]],
    [[w * 0.42, h * 0.84], [w * 0.58, h * 0.84]],
  ],
  "ee-dc-source": (w, h) => [
    [[w * 0.42, h * 0.22], [w * 0.42, h * 0.78]],
    [[w * 0.58, h * 0.36], [w * 0.58, h * 0.64]],
  ],
  "ee-ac-source": (w, h) => {
    const pts = [];
    for (let i = 0; i <= 16; i++) {
      const t = i / 16;
      pts.push([w * (0.22 + t * 0.56), h * (0.5 - Math.sin(t * Math.PI * 2) * 0.22)]);
    }
    return [pts];
  },
  "ee-switch": (w, h) => [
    [[0, h * 0.62], [w * 0.32, h * 0.62]],
    [[w * 0.32, h * 0.62], [w * 0.66, h * 0.28]],
    [[w * 0.68, h * 0.62], [w, h * 0.62]],
  ],
  "ee-transistor": (w, h) => [
    [[w * 0.18, h / 2], [w * 0.42, h / 2]],
    [[w * 0.42, h * 0.26], [w * 0.42, h * 0.74]],
    [[w * 0.42, h * 0.38], [w * 0.72, h * 0.2]],
    [[w * 0.42, h * 0.62], [w * 0.72, h * 0.8]],
  ],
  "ee-op-amp": (w, h) => [
    [[w * 0.14, h * 0.32], [w * 0.26, h * 0.32]],
    [[w * 0.2, h * 0.24], [w * 0.2, h * 0.4]],
    [[w * 0.14, h * 0.68], [w * 0.26, h * 0.68]],
  ],

  // Process Engineering details
  "pe-control-valve": (w, h) => [
    [[w / 2, h * 0.62], [w / 2, h * 0.22]],
    arcPoints(w / 2, h * 0.22, w * 0.26, h * 0.18, Math.PI, Math.PI * 2, 10),
    [[w * 0.24, h * 0.22], [w * 0.76, h * 0.22]],
  ],
  "pe-pump": (w, h) => [
    [[w * 0.2, h * 0.92], [w / 2, h * 0.6], [w * 0.8, h * 0.92]],
    [[w / 2, 0], [w, 0]],
  ],
  "pe-heat-exchanger": (w, h) => [
    [[0, h / 2], [w * 0.32, h / 2], [w * 0.44, h * 0.24], [w * 0.56, h * 0.76], [w * 0.68, h / 2], [w, h / 2]],
  ],
  "pe-reactor": (w, h) => [
    [[w / 2, 0], [w / 2, h * 0.68]],
    [[w * 0.28, h * 0.68], [w * 0.72, h * 0.68]],
  ],
  "pe-filter": (w, h) => [
    [[0, h / 2], [w, h / 2]],
  ],
  "pe-mixer": (w, h) => [
    [[w * 0.2, h * 0.2], [w * 0.8, h * 0.8], [w * 0.8, h * 0.2], [w * 0.2, h * 0.8], [w * 0.2, h * 0.2]],
  ],
  "pe-column": (w, h) => [
    [[0, h * 0.3], [w, h * 0.3]],
    [[0, h * 0.5], [w, h * 0.5]],
    [[0, h * 0.7], [w, h * 0.7]],
  ],
};

/**
 * Catalogue of built-in shape packs shown in the Shapes panel.
 */
export const SHAPE_PACKS = [
  {
    id: "flowchart",
    name: "Flowchart",
    defaultEnabled: true,
    license: "Repository licence (standard ISO 5807 flowchart geometry)",
    shapes: [
      { tool: "shape:fc-process", label: "Process", keywords: ["box", "step", "action"] },
      { tool: "shape:fc-decision", label: "Decision", keywords: ["diamond", "branch", "if"] },
      { tool: "shape:fc-terminator", label: "Terminator", keywords: ["start", "end", "pill"] },
      { tool: "shape:fc-data", label: "Data (I/O)", keywords: ["input", "output", "parallelogram"] },
      { tool: "shape:fc-document", label: "Document", keywords: ["file", "page", "report"] },
      { tool: "shape:fc-multi-document", label: "Multiple documents", keywords: ["files", "reports"] },
      { tool: "shape:fc-database", label: "Database", keywords: ["db", "storage", "cylinder"] },
      { tool: "shape:fc-predefined", label: "Predefined process", keywords: ["subroutine", "function"] },
      { tool: "shape:fc-internal-storage", label: "Internal storage", keywords: ["memory", "ram"] },
      { tool: "shape:fc-manual-input", label: "Manual input", keywords: ["keyboard", "form"] },
      { tool: "shape:fc-manual-operation", label: "Manual operation", keywords: ["trapezoid", "human"] },
      { tool: "shape:fc-preparation", label: "Preparation", keywords: ["setup", "hexagon"] },
      { tool: "shape:fc-delay", label: "Delay", keywords: ["wait", "pause"] },
      { tool: "shape:fc-stored-data", label: "Stored data", keywords: ["archive", "storage"] },
      { tool: "shape:fc-merge", label: "Merge", keywords: ["combine", "triangle"] },
      { tool: "shape:fc-extract", label: "Extract", keywords: ["split", "triangle"] },
      { tool: "shape:fc-or", label: "Logical Or", keywords: ["junction", "circle"] },
      { tool: "shape:fc-summing", label: "Summing junction", keywords: ["and", "cross", "circle"] },
      { tool: "shape:fc-display", label: "Display", keywords: ["screen", "monitor"] },
      { tool: "shape:fc-off-page", label: "Off-page connector", keywords: ["reference", "link"] },
      { tool: "shape:fc-card", label: "Card", keywords: ["punched", "note"] },
    ],
  },
  {
    id: "callouts",
    name: "Callouts",
    defaultEnabled: true,
    license: "Repository licence",
    shapes: [
      { tool: "shape:callout", label: "Rounded callout", keywords: ["speech", "bubble", "comment"] },
      { tool: "shape:callout-rect", label: "Standard callout", keywords: ["rectangle", "note", "tail"] },
      { tool: "shape:callout-oval", label: "Oval speech bubble", keywords: ["balloon", "dialog"] },
      { tool: "shape:callout-bracket", label: "Bracket callout", keywords: ["annotation", "pointer"] },
    ],
  },
  {
    id: "structures",
    name: "Diagram structures",
    defaultEnabled: true,
    license: "Repository licence",
    shapes: [
      { tool: "erd", label: "ER entity table", keywords: ["entity", "relationship", "database", "schema", "table"] },
      { tool: "swimlane", label: "Swimlane pool (horizontal)", keywords: ["lanes", "pool", "process", "rows"] },
      { tool: "swimlane-vertical", label: "Swimlane pool (vertical)", keywords: ["lanes", "pool", "columns"] },
      { tool: "diagram", label: "Diagram container", keywords: ["focus", "layers", "container"] },
    ],
  },
  {
    id: "uml",
    name: "UML",
    defaultEnabled: true,
    license: "Repository licence (standard OMG UML notation)",
    shapes: [
      { tool: "shape:uml-class", label: "UML Class", keywords: ["object", "struct"] },
      { tool: "shape:uml-interface", label: "UML Interface", keywords: ["contract", "protocol"] },
      { tool: "shape:uml-package", label: "UML Package", keywords: ["module", "folder", "namespace"] },
      { tool: "shape:uml-component", label: "UML Component", keywords: ["service", "module"] },
      { tool: "shape:uml-node", label: "UML Node", keywords: ["deployment", "server", "cube"] },
      { tool: "shape:uml-actor", label: "UML Actor", keywords: ["user", "person", "stick"] },
      { tool: "shape:uml-use-case", label: "UML Use Case", keywords: ["scenario", "oval"] },
      { tool: "shape:uml-note", label: "UML Note", keywords: ["comment", "annotation"] },
      { tool: "shape:uml-state", label: "UML State", keywords: ["statechart", "activity"] },
      { tool: "shape:uml-initial-state", label: "UML Initial State", keywords: ["start", "final"] },
      { tool: "shape:uml-lifeline", label: "UML Lifeline", keywords: ["sequence", "timeline"] },
      { tool: "shape:uml-fork-join", label: "UML Fork / Join", keywords: ["bar", "sync"] },
    ],
  },
  {
    id: "bpmn",
    name: "BPMN",
    defaultEnabled: true,
    license: "Repository licence (standard OMG BPMN 2.0 notation)",
    shapes: [
      { tool: "shape:bpmn-task", label: "BPMN Task", keywords: ["activity", "work"] },
      { tool: "shape:bpmn-subprocess", label: "BPMN Sub-process", keywords: ["collapsed", "plus"] },
      { tool: "shape:bpmn-start-event", label: "BPMN Start Event", keywords: ["trigger", "begin"] },
      { tool: "shape:bpmn-intermediate-event", label: "BPMN Intermediate Event", keywords: ["catch", "throw"] },
      { tool: "shape:bpmn-end-event", label: "BPMN End Event", keywords: ["terminate", "finish"] },
      { tool: "shape:bpmn-gateway-exclusive", label: "BPMN Exclusive Gateway", keywords: ["xor", "decision"] },
      { tool: "shape:bpmn-gateway-parallel", label: "BPMN Parallel Gateway", keywords: ["and", "fork"] },
      { tool: "shape:bpmn-gateway-inclusive", label: "BPMN Inclusive Gateway", keywords: ["or", "circle"] },
      { tool: "shape:bpmn-data-object", label: "BPMN Data Object", keywords: ["document", "artifact"] },
      { tool: "shape:bpmn-data-store", label: "BPMN Data Store", keywords: ["database", "persistence"] },
      { tool: "shape:bpmn-message", label: "BPMN Message", keywords: ["envelope", "event"] },
      { tool: "shape:bpmn-annotation", label: "BPMN Annotation", keywords: ["comment", "bracket"] },
    ],
  },
  {
    id: "dfd",
    name: "Data Flow (DFD)",
    defaultEnabled: true,
    license: "Repository licence (Yourdon / Gane-Sarson DFD notation)",
    shapes: [
      { tool: "shape:dfd-entity", label: "DFD External Entity", keywords: ["source", "sink", "actor"] },
      { tool: "shape:dfd-process", label: "DFD Process", keywords: ["gane", "sarson", "transform"] },
      { tool: "shape:dfd-process-circle", label: "DFD Process Circle", keywords: ["yourdon", "bubble"] },
      { tool: "shape:dfd-data-store", label: "DFD Data Store", keywords: ["file", "table", "repository"] },
      { tool: "shape:dfd-multi-process", label: "DFD Multi-process", keywords: ["system", "subsystem"] },
    ],
  },
  {
    id: "vsm",
    name: "Value Stream (VSM)",
    defaultEnabled: true,
    license: "Repository licence (Lean Value Stream Mapping symbols)",
    shapes: [
      { tool: "shape:vsm-process", label: "VSM Process", keywords: ["step", "station"] },
      { tool: "shape:vsm-customer-supplier", label: "VSM Customer / Supplier", keywords: ["factory", "plant"] },
      { tool: "shape:vsm-inventory", label: "VSM Inventory", keywords: ["stock", "wip", "triangle"] },
      { tool: "shape:vsm-supermarket", label: "VSM Supermarket", keywords: ["kanban", "shelf"] },
      { tool: "shape:vsm-kaizen", label: "VSM Kaizen Burst", keywords: ["improvement", "blitz"] },
      { tool: "shape:vsm-fifo", label: "VSM FIFO Lane", keywords: ["queue", "first-in"] },
      { tool: "shape:vsm-shipment", label: "VSM Shipment Truck", keywords: ["delivery", "transport"] },
      { tool: "shape:vsm-push", label: "VSM Push Arrow", keywords: ["material", "flow"] },
      { tool: "shape:vsm-operator", label: "VSM Operator", keywords: ["worker", "staff"] },
    ],
  },
  {
    id: "cloud",
    name: "Cloud and Infrastructure",
    defaultEnabled: true,
    license: "CNCF Kubernetes icons (CC-BY-4.0 / Apache-2.0, The Kubernetes Authors) and Lucide-derived infrastructure geometry (ISC)",
    shapes: [
      { tool: "shape:k8s-wheel", label: "Kubernetes Cluster", keywords: ["k8s", "cncf", "control-plane"] },
      { tool: "shape:k8s-pod", label: "Kubernetes Pod", keywords: ["k8s", "workload", "container"] },
      { tool: "shape:k8s-service", label: "Kubernetes Service", keywords: ["k8s", "svc", "network"] },
      { tool: "shape:k8s-deployment", label: "Kubernetes Deployment", keywords: ["k8s", "replicaset"] },
      { tool: "shape:k8s-ingress", label: "Kubernetes Ingress", keywords: ["k8s", "route", "gateway"] },
      { tool: "shape:k8s-node", label: "Kubernetes Node", keywords: ["k8s", "kubelet", "worker"] },
      { tool: "shape:k8s-pvc", label: "Kubernetes Volume (PVC)", keywords: ["k8s", "storage", "pv"] },
      { tool: "shape:infra-cloud", label: "Cloud Network", keywords: ["vpc", "internet", "edge"] },
      { tool: "shape:infra-server", label: "Compute Server", keywords: ["vm", "instance", "host"] },
      { tool: "shape:infra-container", label: "Container", keywords: ["docker", "oci", "image"] },
      { tool: "shape:infra-serverless", label: "Serverless Function", keywords: ["lambda", "worker", "faas"] },
      { tool: "shape:infra-database", label: "Managed Database", keywords: ["postgres", "sql", "rds"] },
      { tool: "shape:infra-storage", label: "Object Storage", keywords: ["bucket", "gcs", "s3", "blob"] },
      { tool: "shape:infra-load-balancer", label: "Load Balancer", keywords: ["alb", "ingress", "proxy"] },
      { tool: "shape:infra-cdn", label: "CDN Edge", keywords: ["cache", "distribution", "dns"] },
      { tool: "shape:infra-firewall", label: "Firewall / WAF", keywords: ["security", "shield", "iam"] },
      { tool: "shape:infra-vpc", label: "Virtual Private Cloud", keywords: ["subnet", "network"] },
      { tool: "shape:infra-queue", label: "Message Queue", keywords: ["pubsub", "kafka", "bus"] },
      { tool: "shape:infra-router", label: "Network Router", keywords: ["switch", "gateway", "nat"] },
    ],
  },
  {
    id: "electrical",
    name: "Electrical Engineering",
    defaultEnabled: false,
    license: "Repository licence (standard IEC 60617 schematic symbols)",
    shapes: [
      { tool: "shape:ee-resistor", label: "Resistor", keywords: ["ohm", "circuit", "impedance"] },
      { tool: "shape:ee-capacitor", label: "Capacitor", keywords: ["farad", "condenser"] },
      { tool: "shape:ee-inductor", label: "Inductor", keywords: ["coil", "henry", "choke"] },
      { tool: "shape:ee-diode", label: "Diode", keywords: ["rectifier", "led", "semiconductor"] },
      { tool: "shape:ee-ground", label: "Ground", keywords: ["earth", "gnd", "reference"] },
      { tool: "shape:ee-dc-source", label: "DC Source", keywords: ["battery", "voltage", "power"] },
      { tool: "shape:ee-ac-source", label: "AC Source", keywords: ["alternating", "sine", "generator"] },
      { tool: "shape:ee-switch", label: "Switch", keywords: ["spst", "relay", "contact"] },
      { tool: "shape:ee-transistor", label: "Transistor", keywords: ["npn", "bjt", "mosfet"] },
      { tool: "shape:ee-op-amp", label: "Op-Amp", keywords: ["amplifier", "comparator"] },
      { tool: "shape:ee-and-gate", label: "AND Gate", keywords: ["logic", "digital", "boolean"] },
      { tool: "shape:ee-or-gate", label: "OR Gate", keywords: ["logic", "digital", "boolean"] },
    ],
  },
  {
    id: "process",
    name: "Process Engineering",
    defaultEnabled: false,
    license: "Repository licence (standard ISO 10628 / ISA S5.1 P&ID symbols)",
    shapes: [
      { tool: "shape:pe-valve", label: "Valve", keywords: ["gate", "globe", "pipe"] },
      { tool: "shape:pe-control-valve", label: "Control Valve", keywords: ["actuator", "diaphragm"] },
      { tool: "shape:pe-pump", label: "Centrifugal Pump", keywords: ["fluid", "flow"] },
      { tool: "shape:pe-compressor", label: "Compressor", keywords: ["gas", "turbine"] },
      { tool: "shape:pe-heat-exchanger", label: "Heat Exchanger", keywords: ["condenser", "cooler"] },
      { tool: "shape:pe-vessel", label: "Vessel / Tank", keywords: ["drum", "storage"] },
      { tool: "shape:pe-reactor", label: "Reactor", keywords: ["agitator", "chemical"] },
      { tool: "shape:pe-filter", label: "Filter", keywords: ["strainer", "separator"] },
      { tool: "shape:pe-mixer", label: "Mixer", keywords: ["blender", "impeller"] },
      { tool: "shape:pe-column", label: "Distillation Column", keywords: ["tower", "fractionation"] },
    ],
  },
];

import { registerShapePack } from "./shapes";

const ENABLED_PACKS_STORAGE_KEY = "veevee:canvas:enabled-shape-packs:v1";

registerShapePack(PACK_OUTLINES, PACK_DETAILS);


export function defaultEnabledPackIds() {
  return SHAPE_PACKS.filter((p) => p.defaultEnabled).map((p) => p.id);
}

for (const pack of SHAPE_PACKS) {
  if (!pack.label) pack.label = pack.name;
  if (!pack.description) pack.description = pack.license;
}

export function readEnabledPackIds() {
  if (typeof window === "undefined") return defaultEnabledPackIds();
  try {
    const raw = window.localStorage.getItem(ENABLED_PACKS_STORAGE_KEY);
    if (!raw) return defaultEnabledPackIds();
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((id) => typeof id === "string")) {
      return parsed;
    }
  } catch {
    /* ignore storage errors */
  }
  return defaultEnabledPackIds();
}

export const loadEnabledPackIds = readEnabledPackIds;

export function saveEnabledPackIds(packIds) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(ENABLED_PACKS_STORAGE_KEY, JSON.stringify(packIds));
  } catch {
    /* ignore storage errors */
  }
}

export function filterShapeItem(item, query) {
  const q = (query || "").trim().toLowerCase();
  if (!q) return true;
  if (item.label.toLowerCase().includes(q)) return true;
  if (item.tool.toLowerCase().includes(q)) return true;
  if (Array.isArray(item.keywords) && item.keywords.some((k) => k.toLowerCase().includes(q))) {
    return true;
  }
  return false;
}

export function filterShapePacks(packs = SHAPE_PACKS, enabledIds = null, query = "") {
  const enabledSet = Array.isArray(enabledIds) ? new Set(enabledIds) : null;
  const q = (query || "").trim();
  const out = [];
  for (const pack of packs) {
    if (!q && enabledSet && !enabledSet.has(pack.id)) continue;
    const shapes = q ? pack.shapes.filter((s) => filterShapeItem(s, q)) : pack.shapes;
    if (shapes.length > 0) {
      out.push({ ...pack, label: pack.label || pack.name, description: pack.description || pack.license, shapes });
    }
  }
  return out;
}
