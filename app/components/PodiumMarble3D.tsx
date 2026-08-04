"use client";

import { Canvas } from "@react-three/fiber";
import { Suspense } from "react";
import Marble3D from "./Marble3D";
import Studio from "./Studio";
import type { RacerItem } from "../data/categories";

// One spinning HD 3D glossy marble for a podium slot.
export default function PodiumMarble3D({ item }: { item: RacerItem }) {
  return (
    <Canvas
      dpr={[1, 2]}
      camera={{ position: [0, 0, 3.7], fov: 33 }}
      gl={{ antialias: true, alpha: true }}
    >
      <Suspense fallback={null}>
        <Studio />
        <Marble3D item={item} />
      </Suspense>
    </Canvas>
  );
}
