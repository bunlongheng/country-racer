"use client";

import { useTexture } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";

// A true 3D glossy marble: a high-poly sphere wrapped with the flag and finished
// with a clearcoat so it reads like polished glass. Auto-rotates.
export default function Marble3D({ code, hue }: { code: string; hue: number }) {
  const tex = useTexture(`/flags/${code}.png`);
  const ref = useRef<THREE.Mesh>(null);
  const emissive = useMemo(() => new THREE.Color().setHSL(hue / 360, 0.9, 0.5), [hue]);

  useMemo(() => {
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
  }, [tex]);

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
