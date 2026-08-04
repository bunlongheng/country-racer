"use client";

import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { itemTexture } from "./marbleTexture";
import type { RacerItem } from "../data/categories";

// A true 3D glossy marble: a high-poly sphere wrapped with the racer's skin (flag,
// emoji, or solid colour) and finished with a clearcoat so it reads like polished
// glass. Auto-rotates.
export default function Marble3D({ item }: { item: RacerItem }) {
  const tex = useMemo(() => itemTexture(item), [item]);
  const ref = useRef<THREE.Mesh>(null);
  const emissive = useMemo(() => new THREE.Color().setHSL(item.hue / 360, 0.9, 0.5), [item.hue]);

  useEffect(() => () => tex.dispose(), [tex]);

  useFrame((_, dt) => {
    if (ref.current) ref.current.rotation.y += dt * 0.9;
  });

  return (
    <mesh ref={ref}>
      <sphereGeometry args={[1, 64, 64]} />
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
