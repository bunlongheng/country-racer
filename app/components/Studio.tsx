"use client";

import { Environment, Lightformer } from "@react-three/drei";

// Lighting + procedural reflections for the podium marbles. The environment map
// is built from these light shapes (no HDR fetched), so reflections stay glossy
// while the CSP stays locked to 'self'.
export default function Studio() {
  return (
    <>
      <ambientLight intensity={0.55} />
      <directionalLight position={[4, 8, 5]} intensity={2.1} />
      <directionalLight position={[-6, 3, -4]} intensity={0.6} color="#9ec5ff" />
      <Environment resolution={256}>
        <Lightformer form="rect" intensity={3} position={[3, 4, 4]} scale={[6, 6, 1]} color="#ffffff" />
        <Lightformer form="circle" intensity={1.4} position={[-4, 2, -3]} scale={[4, 4, 1]} color="#88b7ff" />
        <Lightformer form="rect" intensity={1} position={[0, -3, 2]} scale={[8, 3, 1]} color="#3a3a52" />
      </Environment>
    </>
  );
}
