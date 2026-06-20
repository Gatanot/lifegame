#include "perlin_noise.h"
#include <cmath>

PerlinNoise::PerlinNoise(uint32_t seed)
{
    initPermutation(seed);
}

void PerlinNoise::setSeed(uint32_t seed)
{
    initPermutation(seed);
}

void PerlinNoise::initPermutation(uint32_t seed)
{
    for (int i = 0; i < SIZE; i++)
    {
        perm[i] = i;
    }

    uint32_t state = seed ? seed : 1;
    for (int i = SIZE - 1; i > 0; i--)
    {
        state = state * 1103515245 + 12345;
        int j = (state >> 16) % (i + 1);
        uint8_t t = perm[i];
        perm[i] = perm[j];
        perm[j] = t;
    }

    for (int i = 0; i < SIZE; i++)
    {
        perm[SIZE + i] = perm[i];
    }
}

float PerlinNoise::fade(float t)
{
    return t * t * t * (t * (t * 6.0f - 15.0f) + 10.0f);
}

float PerlinNoise::lerp(float a, float b, float t)
{
    return a + t * (b - a);
}

float PerlinNoise::grad2D(int hash, float x, float y)
{
    int h = hash & 3;
    float u = (h < 2) ? x : y;
    float v = (h < 2) ? y : x;
    return ((h & 1) == 0 ? u : -u) + ((h & 2) == 0 ? v : -v);
}

float PerlinNoise::grad3D(int hash, float x, float y, float z)
{
    int h = hash & 15;
    float u = (h < 8) ? x : y;
    float v = (h < 4) ? y : ((h == 12 || h == 14) ? x : z);
    return ((h & 1) == 0 ? u : -u) + ((h & 2) == 0 ? v : -v);
}

float PerlinNoise::noise2D(float x, float y) const
{
    int X = (int)std::floor(x) & (SIZE - 1);
    int Y = (int)std::floor(y) & (SIZE - 1);

    float xf = x - std::floor(x);
    float yf = y - std::floor(y);

    float u = fade(xf);
    float v = fade(yf);

    int aa = perm[perm[X] + Y];
    int ab = perm[perm[X] + Y + 1];
    int ba = perm[perm[X + 1] + Y];
    int bb = perm[perm[X + 1] + Y + 1];

    float x1 = lerp(grad2D(aa, xf, yf), grad2D(ba, xf - 1.0f, yf), u);
    float x2 = lerp(grad2D(ab, xf, yf - 1.0f), grad2D(bb, xf - 1.0f, yf - 1.0f), u);

    return lerp(x1, x2, v);
}

float PerlinNoise::noise3D(float x, float y, float z) const
{
    int X = (int)std::floor(x) & (SIZE - 1);
    int Y = (int)std::floor(y) & (SIZE - 1);
    int Z = (int)std::floor(z) & (SIZE - 1);

    float xf = x - std::floor(x);
    float yf = y - std::floor(y);
    float zf = z - std::floor(z);

    float u = fade(xf);
    float v = fade(yf);
    float w = fade(zf);

    int A = perm[X] + Y;
    int AA = perm[A] + Z;
    int AB = perm[A + 1] + Z;
    int B = perm[X + 1] + Y;
    int BA = perm[B] + Z;
    int BB = perm[B + 1] + Z;

    float g1 = grad3D(perm[AA], xf, yf, zf);
    float g2 = grad3D(perm[BA], xf - 1.0f, yf, zf);
    float g3 = grad3D(perm[AB], xf, yf - 1.0f, zf);
    float g4 = grad3D(perm[BB], xf - 1.0f, yf - 1.0f, zf);
    float g5 = grad3D(perm[AA + 1], xf, yf, zf - 1.0f);
    float g6 = grad3D(perm[BA + 1], xf - 1.0f, yf, zf - 1.0f);
    float g7 = grad3D(perm[AB + 1], xf, yf - 1.0f, zf - 1.0f);
    float g8 = grad3D(perm[BB + 1], xf - 1.0f, yf - 1.0f, zf - 1.0f);

    float x1 = lerp(g1, g2, u);
    float x2 = lerp(g3, g4, u);
    float x3 = lerp(g5, g6, u);
    float x4 = lerp(g7, g8, u);

    float y1 = lerp(x1, x2, v);
    float y2 = lerp(x3, x4, v);

    return lerp(y1, y2, w);
}

float PerlinNoise::fbm2D(float x, float y, int octaves, float lacunarity, float gain) const
{
    float value = 0.0f;
    float amplitude = 1.0f;
    float frequency = 1.0f;
    float maxValue = 0.0f;

    for (int i = 0; i < octaves; i++)
    {
        value += amplitude * noise2D(x * frequency, y * frequency);
        maxValue += amplitude;
        amplitude *= gain;
        frequency *= lacunarity;
    }

    return value / maxValue;
}

float PerlinNoise::fbm3D(float x, float y, float z, int octaves, float lacunarity, float gain) const
{
    float value = 0.0f;
    float amplitude = 1.0f;
    float frequency = 1.0f;
    float maxValue = 0.0f;

    for (int i = 0; i < octaves; i++)
    {
        value += amplitude * noise3D(x * frequency, y * frequency, z * frequency);
        maxValue += amplitude;
        amplitude *= gain;
        frequency *= lacunarity;
    }

    return value / maxValue;
}
