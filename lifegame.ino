/**
 * Conway's Game of Life for ESP32-S3-RLCD-4.2
 *
 * 硬件: 4.2" 反射式 LCD (400x300), GP18 按键 (GPIO18)
 * 行为:
 *   - 上电: 随机初始网格, 暂停状态
 *   - GP18 单击: 切换 运行/暂停
 *   - 更新速率: 5 次/秒 (200ms)
 *
 * 编译: Arduino IDE 打开本文件夹 (ESP32-S3 board package).
 */
#include <cmath>
#include <cstdlib>
#include <freertos/FreeRTOS.h>
#include <freertos/event_groups.h>
#include <esp_system.h>
#include "display_bsp.h"
#include "button_bsp.h"
#include "perlin_noise.h"

// 屏幕
// SPI: MOSI=12, SCK=11, DC=5, CS=40, RST=41
DisplayPort RlcdPort(12, 11, 5, 40, 41, 400, 300);

// 生命游戏状态
#define COLS 400
#define ROWS 300
#define N 2                   // 每个逻辑像素渲染为 NxN 物理像素
#define LOGIC_COLS (COLS / N) // 200
#define LOGIC_ROWS (ROWS / N) // 150

static uint8_t *grid_a = NULL;
static uint8_t *grid_b = NULL;
static uint8_t *front = NULL;         // 当前可见网格 (LOGIC_COLS x LOGIC_ROWS)
static uint8_t *back = NULL;          // 下一代网格缓冲
static float *elevation_map = NULL;   // 高程图 (0-255)
static float *elevation_tmp = NULL;   // 侵蚀/扩散双缓冲
static float *water_flow = NULL;      // 水流累积量
static uint16_t *sort_indices = NULL; // 排序索引 (用于水流路由)
static int terrain_evo_counter = 0;
#define TERRAIN_EVO_INTERVAL 20
#define EROSION_RATE 0.008f  // 每邻域侵蚀比例
#define DIFFUSION_RATE 0.06f // 扩散混合比
#define BASE_LEVEL 60.0f
#define UPLIFT_AMOUNT 0.12f      // 相干抬升幅度
#define MIN_SLOPE 1.5f           // 触发侵蚀的最小坡度
#define FLOW_EROSION_BONUS 0.04f // 水流加成侵蚀
#define CATASTROPHE_INTERVAL 7   // 灾难事件间隔 (7x20=140 代, ~28s)
#define CAT_RADIUS_MIN 12
#define CAT_RADIUS_MAX 40
#define CAT_UPLIFT_MIN 35.0f
#define CAT_UPLIFT_MAX 100.0f
#define CAT_DROP_MIN 25.0f
#define CAT_DROP_MAX 80.0f
static int terrain_evo_count = 0; // 记录 elevation_update() 调用次数
static volatile bool running = false;

// 生命游戏逻辑
// 地形类型 -- 根据高程阈值划分 (0-255)
#define TERRAIN_COUNT 6
static const float TERRAIN_HABITABILITY[TERRAIN_COUNT] = {0.02f, 0.05f, 0.15f, 0.50f, 0.70f, 0.25f};
// 每种地形的邻域计数规则 (存活/出生的 min-max)
static const int SURVIVE_MIN[TERRAIN_COUNT] = {3, 2, 2, 2, 2, 2};
static const int SURVIVE_MAX[TERRAIN_COUNT] = {3, 3, 4, 3, 4, 3};
static const int BIRTH_MIN[TERRAIN_COUNT] = {1, 3, 3, 3, 3, 3};
static const int BIRTH_MAX[TERRAIN_COUNT] = {0, 3, 3, 3, 4, 4};

static int get_terrain_from_elevation(float e)
{
  static const int bounds[5] = {51, 81, 111, 161, 201};
  for (int i = 0; i < 5; i++)
  {
    if (e < bounds[i])
      return i;
  }
  return 5;
}

// qsort 比较函数: 高程降序 (水流路由用, 从高到低)
static int cmp_elev_desc(const void *a, const void *b)
{
  uint16_t ia = *(const uint16_t *)a;
  uint16_t ib = *(const uint16_t *)b;
  float ea = elevation_map[ia];
  float eb = elevation_map[ib];
  if (eb > ea)
    return 1;
  if (eb < ea)
    return -1;
  return 0;
}

// 地形噪声 (支持 setSeed 重置) 和抬升噪声
static PerlinNoise terrain_noise(42);
static PerlinNoise uplift_noise(42 ^ 0xABCD);

static void gol_randomize(uint8_t *g)
{
  float scale = 0.06f;

  for (int y = 0; y < LOGIC_ROWS; y++)
  {
    for (int x = 0; x < LOGIC_COLS; x++)
    {
      float val = terrain_noise.fbm2D(x * scale, y * scale, 3);
      float elev = (val + 1.0f) * 127.5f;
      elevation_map[y * LOGIC_COLS + x] = elev;
      int t = get_terrain_from_elevation(elev);
      float p = TERRAIN_HABITABILITY[t];
      g[y * LOGIC_COLS + x] = ((float)esp_random() / (float)UINT32_MAX) < p ? 1 : 0;
    }
  }
}

static void elevation_update(void)
{
  int cell_count = LOGIC_COLS * LOGIC_ROWS;

  // Phase 1: 水流累积
  // 按高程降序排序, 水往低处流
  for (int i = 0; i < cell_count; i++)
  {
    sort_indices[i] = (uint16_t)i;
    water_flow[i] = 0.0f;
  }
  qsort(sort_indices, cell_count, sizeof(uint16_t), cmp_elev_desc);

  for (int i = 0; i < cell_count; i++)
  {
    uint16_t idx = sort_indices[i];
    int y = idx / LOGIC_COLS;
    int x = idx % LOGIC_COLS;
    float e = elevation_map[idx];
    float lowest_e = e;
    int lowest_ni = -1;

    for (int dy = -1; dy <= 1; dy++)
    {
      int ny = (y + dy + LOGIC_ROWS) % LOGIC_ROWS;
      for (int dx = -1; dx <= 1; dx++)
      {
        if (dy == 0 && dx == 0)
          continue;
        int nx = (x + dx + LOGIC_COLS) % LOGIC_COLS;
        int ni = ny * LOGIC_COLS + nx;
        if (elevation_map[ni] < lowest_e)
        {
          lowest_e = elevation_map[ni];
          lowest_ni = ni;
        }
      }
    }
    if (lowest_ni >= 0)
    {
      water_flow[lowest_ni] += 1.0f + water_flow[idx];
    }
  }

  // Phase 2: 阈值液压侵蚀
  // 生物反馈: 活细胞保护地形, 荒芜细胞加速侵蚀
  for (int i = 0; i < cell_count; i++)
  {
    elevation_tmp[i] = elevation_map[i];
  }

  for (int i = 0; i < cell_count; i++)
  {
    uint16_t idx = sort_indices[i];
    int y = idx / LOGIC_COLS;
    int x = idx % LOGIC_COLS;
    float e = elevation_tmp[idx];
    if (e <= BASE_LEVEL)
      continue;

    float max_drop = 0.0f;
    int steepest_ni = -1;
    float density = (float)front[idx]; // 3x3 局部种群密度
    for (int dy = -1; dy <= 1; dy++)
    {
      int ny = (y + dy + LOGIC_ROWS) % LOGIC_ROWS;
      for (int dx = -1; dx <= 1; dx++)
      {
        if (dy == 0 && dx == 0)
          continue;
        int nx = (x + dx + LOGIC_COLS) % LOGIC_COLS;
        int ni = ny * LOGIC_COLS + nx;
        float drop = e - elevation_tmp[ni];
        if (drop > max_drop)
        {
          max_drop = drop;
          steepest_ni = ni;
        }
        density += (float)front[ni];
      }
    }
    density /= 9.0f;
    if (max_drop < MIN_SLOPE)
      continue;

    float bio_factor = (density > 0.5f) ? 0.3f : ((density < 0.2f) ? 1.5f : 0.7f);
    float flow_factor = sqrtf(water_flow[idx] + 1.0f) * FLOW_EROSION_BONUS;
    float erosion = (EROSION_RATE + flow_factor) * max_drop * bio_factor;
    float real_erosion = (erosion < (e - BASE_LEVEL)) ? erosion : (e - BASE_LEVEL);

    if (real_erosion > 0.0f && steepest_ni >= 0)
    {
      elevation_tmp[idx] -= real_erosion;
      elevation_tmp[steepest_ni] += real_erosion * 0.85f; // 85% 沉积, 15% 流失
    }
  }

  // Phase 2b: 有机沉积 -- 活细胞群中的死细胞聚集沉积物
  for (int i = 0; i < cell_count; i++)
  {
    if (front[i])
      continue;
    int y = i / LOGIC_COLS;
    int x = i % LOGIC_COLS;
    float density = 0.0f;
    for (int dy = -1; dy <= 1; dy++)
    {
      int ny = (y + dy + LOGIC_ROWS) % LOGIC_ROWS;
      for (int dx = -1; dx <= 1; dx++)
      {
        density += (float)front[ny * LOGIC_COLS + ((x + dx + LOGIC_COLS) % LOGIC_COLS)];
      }
    }
    density /= 9.0f;
    if (density > 0.3f)
    {
      elevation_tmp[i] += density * 0.08f;
    }
  }

  for (int i = 0; i < cell_count; i++)
  {
    elevation_map[i] = elevation_tmp[i];
  }

  // Phase 3: 相干 Perlin 噪声抬升 (替代白噪声)
  // 双倍频景观尺度噪声生成山脉
  float u_scale = 0.03f;
  for (int y = 0; y < LOGIC_ROWS; y++)
  {
    for (int x = 0; x < LOGIC_COLS; x++)
    {
      int idx = y * LOGIC_COLS + x;
      float u = uplift_noise.noise2D(x * u_scale, y * u_scale);
      float v = uplift_noise.noise2D(x * u_scale * 2.7f + 3.1f, y * u_scale * 2.7f + 3.1f);
      elevation_map[idx] += (u * 0.7f + v * 0.3f) * UPLIFT_AMOUNT * 2.5f;
    }
  }

  // Phase 4: 扩散平滑 -- 将抬升塑造成圆润山丘
  for (int y = 0; y < LOGIC_ROWS; y++)
  {
    for (int x = 0; x < LOGIC_COLS; x++)
    {
      int idx = y * LOGIC_COLS + x;
      float avg = 0.0f;
      for (int dy = -1; dy <= 1; dy++)
      {
        int ny = (y + dy + LOGIC_ROWS) % LOGIC_ROWS;
        for (int dx = -1; dx <= 1; dx++)
        {
          if (dy == 0 && dx == 0)
            continue;
          int nx = (x + dx + LOGIC_COLS) % LOGIC_COLS;
          avg += elevation_map[ny * LOGIC_COLS + nx];
        }
      }
      avg /= 8.0f;
      elevation_tmp[idx] = elevation_map[idx] * (1.0f - DIFFUSION_RATE) + avg * DIFFUSION_RATE;
    }
  }

  // Phase 5: 灾难事件 -- 稀有抬升/塌陷/洪水
  terrain_evo_count++;
  if (terrain_evo_count >= CATASTROPHE_INTERVAL)
  {
    terrain_evo_count = 0;
    int cx = esp_random() % LOGIC_COLS;
    int cy = esp_random() % LOGIC_ROWS;
    int radius = CAT_RADIUS_MIN + (esp_random() % (CAT_RADIUS_MAX - CAT_RADIUS_MIN + 1));
    int r2 = radius * radius;
    uint32_t type = esp_random();

    int x0 = (cx - radius > 0) ? (cx - radius) : 0;
    int x1 = (cx + radius < LOGIC_COLS - 1) ? (cx + radius) : (LOGIC_COLS - 1);
    int y0 = (cy - radius > 0) ? (cy - radius) : 0;
    int y1 = (cy + radius < LOGIC_ROWS - 1) ? (cy + radius) : (LOGIC_ROWS - 1);

    if (type % 100 < 30)
    {
      // 抬升: 火山 (30%)
      float amount = CAT_UPLIFT_MIN + ((float)esp_random() / (float)UINT32_MAX) * (CAT_UPLIFT_MAX - CAT_UPLIFT_MIN);
      for (int y = y0; y <= y1; y++)
      {
        for (int x = x0; x <= x1; x++)
        {
          int dx = x - cx, dy = y - cy;
          int d2 = dx * dx + dy * dy;
          if (d2 < r2)
          {
            float t = 1.0f - (float)d2 / (float)r2;
            float factor = t * t * (3.0f - 2.0f * t); // smoothstep
            int idx = y * LOGIC_COLS + x;
            elevation_tmp[idx] += amount * factor;
            front[idx] = 0; // 摧毁爆炸区生命
          }
        }
      }
    }
    else if (type % 100 < 60)
    {
      // 塌陷: 天坑/火山口 (30%)
      float amount = CAT_DROP_MIN + ((float)esp_random() / (float)UINT32_MAX) * (CAT_DROP_MAX - CAT_DROP_MIN);
      for (int y = y0; y <= y1; y++)
      {
        for (int x = x0; x <= x1; x++)
        {
          int dx = x - cx, dy = y - cy;
          int d2 = dx * dx + dy * dy;
          if (d2 < r2)
          {
            float t = 1.0f - (float)d2 / (float)r2;
            float factor = t * t * (3.0f - 2.0f * t);
            int idx = y * LOGIC_COLS + x;
            elevation_tmp[idx] -= amount * factor;
            front[idx] = 0;
          }
        }
      }
    }
    else if (type % 100 < 80)
    {
      // 洪水: 突袭海平面上升 (20%)
      for (int y = y0; y <= y1; y++)
      {
        for (int x = x0; x <= x1; x++)
        {
          int dx = x - cx, dy = y - cy;
          int d2 = dx * dx + dy * dy;
          if (d2 < r2)
          {
            float t = 1.0f - (float)d2 / (float)r2;
            float factor = t * t * (3.0f - 2.0f * t);
            int idx = y * LOGIC_COLS + x;
            float target = BASE_LEVEL - 5.0f - ((float)esp_random() / (float)UINT32_MAX) * 20.0f;
            elevation_tmp[idx] += (target - elevation_tmp[idx]) * factor;
            front[idx] = 0;
          }
        }
      }
    }
  }

  // 最终: 钳位到 [0, 255]
  for (int i = 0; i < cell_count; i++)
  {
    float v = elevation_tmp[i];
    if (v < 0.0f)
      v = 0.0f;
    if (v > 255.0f)
      v = 255.0f;
    elevation_map[i] = v;
    elevation_tmp[i] = 0.0f;
  }
}

static void gol_update(void)
{
  terrain_evo_counter++;
  if (terrain_evo_counter >= TERRAIN_EVO_INTERVAL)
  {
    terrain_evo_counter = 0;
    elevation_update();
  }

  for (int y = 0; y < LOGIC_ROWS; y++)
  {
    for (int x = 0; x < LOGIC_COLS; x++)
    {
      int n = 0;
      for (int dy = -1; dy <= 1; dy++)
      {
        int ny = (y + dy + LOGIC_ROWS) % LOGIC_ROWS;
        for (int dx = -1; dx <= 1; dx++)
        {
          if (dy == 0 && dx == 0)
            continue;
          int nx = (x + dx + LOGIC_COLS) % LOGIC_COLS;
          n += front[ny * LOGIC_COLS + nx];
        }
      }

      uint8_t cell = front[y * LOGIC_COLS + x];
      int t = get_terrain_from_elevation(elevation_map[y * LOGIC_COLS + x]);

      if (cell)
      {
        back[y * LOGIC_COLS + x] = (n >= SURVIVE_MIN[t] && n <= SURVIVE_MAX[t]);
      }
      else
      {
        back[y * LOGIC_COLS + x] = (n >= BIRTH_MIN[t] && n <= BIRTH_MAX[t]);
      }
    }
  }
  uint8_t *tmp = front;
  front = back;
  back = tmp;
}

static void gol_render(void)
{
  // 清屏为白色, 然后将每个活细胞画为 NxN 黑色方块
  RlcdPort.RLCD_ColorClear(ColorWhite);
  for (int y = 0; y < LOGIC_ROWS; y++)
  {
    for (int x = 0; x < LOGIC_COLS; x++)
    {
      if (front[y * LOGIC_COLS + x])
      {
#if N == 4
        RlcdPort.RLCD_FillBlock4(x, y, ColorBlack);
#elif N == 2
        RlcdPort.RLCD_FillBlock2(x, y, ColorBlack);
#endif
      }
    }
  }
  RlcdPort.RLCD_Display();
}

// FreeRTOS 任务: 游戏循环
void GameTask(void *arg)
{
  gol_randomize(front);
  gol_render();

  for (;;)
  {
    // 每 200ms 轮询按键 (非阻塞, 确保 BOOT 中断正常工作)
    TickType_t timeout = pdMS_TO_TICKS(200);

    EventBits_t ev = xEventGroupWaitBits(GP18ButtonGroups,
                                         0x01, pdTRUE, pdFALSE, timeout);

    if (ev & 0x01)
    {
      running = !running;
    }

    // BOOT 单击 -> 重新播种地形并生成新世界, 保持暂停
    EventBits_t boot_ev = xEventGroupWaitBits(BootButtonGroups,
                                              0x01, pdTRUE, pdFALSE, 0);
    if (boot_ev & 0x01)
    {
      terrain_noise.setSeed(esp_random());
      gol_randomize(front);
      gol_render();
      running = false;
    }

    if (running)
    {
      gol_update();
      gol_render();
    }
  }
}

// Arduino 入口
void setup()
{
  int cell_count = LOGIC_COLS * LOGIC_ROWS;
  grid_a = (uint8_t *)heap_caps_malloc(cell_count, MALLOC_CAP_SPIRAM);
  grid_b = (uint8_t *)heap_caps_malloc(cell_count, MALLOC_CAP_SPIRAM);
  elevation_map = (float *)heap_caps_malloc(cell_count * sizeof(float), MALLOC_CAP_SPIRAM);
  elevation_tmp = (float *)heap_caps_malloc(cell_count * sizeof(float), MALLOC_CAP_SPIRAM);
  water_flow = (float *)heap_caps_malloc(cell_count * sizeof(float), MALLOC_CAP_SPIRAM);
  sort_indices = (uint16_t *)heap_caps_malloc(cell_count * sizeof(uint16_t), MALLOC_CAP_SPIRAM);
  assert(grid_a && grid_b && elevation_map && elevation_tmp && water_flow && sort_indices);
  front = grid_a;
  back = grid_b;

  // 初始化外设
  RlcdPort.RLCD_Init();
  Custom_ButtonInit();

  // 游戏任务固定在 Core 1; Core 0 空闲
  xTaskCreatePinnedToCore(GameTask, "GameOfLife", 6 * 1024, NULL, 2, NULL, 1);
}

void loop()
{
  // 所有工作在 GameTask 中
  vTaskDelay(pdMS_TO_TICKS(1000));
}
