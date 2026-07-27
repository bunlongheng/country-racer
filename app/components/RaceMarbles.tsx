"use client";

import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useTexture } from "@react-three/drei";
import { Suspense, useMemo, useRef, type RefObject } from "react";
import * as THREE from "three";
import Studio from "./Studio";

// Per-frame render data written by the 2D physics loop (CSS pixels).
export type MarbleRender = {
  x: number;
  y: number;
  r: number;
  dx: number; // unit travel direction (screen)
  dy: number;
  dist: number;
  flash: number; // 0..1 hit-flash timer
  good: boolean; // green (good) or red (bad) flash
};

const GREEN = new THREE.Color("#3ee06a");
const RED = new THREE.Color("#ff4a44");

function Ball({
  code,
  hue,
  index,
  data,
}: {
  code: string;
  hue: number;
  index: number;
  data: RefObject<MarbleRender[]>;
}) {
  const tex = useTexture(`/flags/${code}.png`);
  const ref = useRef<THREE.Mesh>(null);
  const prev = useRef(0);
  const { size } = useThree();
  const emissive = useMemo(() => new THREE.Color().setHSL(hue / 360, 0.9, 0.5), [hue]);

  useMemo(() => {
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
  }, [tex]);

  useFrame(() => {
    const m = ref.current;
    const d = data.current?.[index];
    if (!m) return;
    if (!d) {
      m.visible = false;
      return;
    }
    m.visible = true;
    m.position.set(d.x - size.width / 2, -(d.y - size.height / 2), 0);
    m.scale.setScalar(Math.max(0.001, d.r));
    // Roll about the axis perpendicular to travel (true top-down rolling).
    const len = Math.hypot(d.dx, d.dy);
    if (len > 1e-5) {
      const axis = new THREE.Vector3(-d.dy / len, -d.dx / len, 0);
      const dRoll = (d.dist - prev.current) * 0.11;
      m.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(axis, dRoll));
    }
    prev.current = d.dist;
    // Hit flash: the edge glows red (bad) or green (good) for ~1s.
    const mat = m.material as THREE.MeshPhysicalMaterial;
    if (d.flash > 0) {
      mat.emissive.copy(d.good ? GREEN : RED);
      mat.emissiveIntensity = 0.9 * d.flash;
    } else {
      mat.emissive.copy(emissive);
      mat.emissiveIntensity = 0.06;
    }
  });

  return (
    <mesh ref={ref} visible={false}>
      <sphereGeometry args={[1, 48, 48]} />
      <meshPhysicalMaterial
        map={tex}
        roughness={0.14}
        metalness={0}
        clearcoat={1}
        clearcoatRoughness={0.06}
        envMapIntensity={1.15}
        emissive={emissive}
        emissiveIntensity={0.06}
      />
    </mesh>
  );
}

export default function RaceMarbles({
  codes,
  data,
}: {
  codes: { code: string; hue: number }[];
  data: RefObject<MarbleRender[]>;
}) {
  return (
    <Canvas
      orthographic
      camera={{ position: [0, 0, 100], zoom: 1, near: 0.1, far: 1000 }}
      gl={{ alpha: true, antialias: true }}
      dpr={[1, 2]}
      className="pointer-events-none absolute inset-0"
    >
      <Suspense fallback={null}>
        <Studio />
        {codes.map((c, i) => (
          <Ball key={i} code={c.code} hue={c.hue} index={i} data={data} />
        ))}
      </Suspense>
    </Canvas>
  );
}
