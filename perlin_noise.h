#pragma once

#include <cstdint>

class PerlinNoise
{
public:
    explicit PerlinNoise(uint32_t seed = 0);
    void setSeed(uint32_t seed); // 运行时重新播种, 产生不同地形

    float noise2D(float x, float y) const; // 二维 Perlin 噪声 [-1, 1]
    float noise3D(float x, float y, float z) const;

    float fbm2D(float x, float y, int octaves = 4, float lacunarity = 2.0f, float gain = 0.5f) const;
    float fbm3D(float x, float y, float z, int octaves = 4, float lacunarity = 2.0f, float gain = 0.5f) const;

private:
    static constexpr int SIZE = 256;
    uint8_t perm[SIZE * 2];

    static float fade(float t);
    static float lerp(float a, float b, float t);
    static float grad2D(int hash, float x, float y);
    static float grad3D(int hash, float x, float y, float z);

    void initPermutation(uint32_t seed);
};
