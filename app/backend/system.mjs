import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

export async function systemInfo(libraryRoot, profiles = [], models = []) {
  const disk = await diskSpaceBytes(libraryRoot);
  const free = disk.free;
  const totalDisk = disk.total;
  const memory = await memorySnapshot();
  const totalMem = memory.totalBytes;
  const cpuCount = os.cpus().length;
  const tier = classifyTier(totalMem, free);
  const recommendationCaps = {
    maxTotalDiskPercent: 40,
    maxFreeDiskPercent: 20,
    maxTotalDiskBytes: Math.floor(totalDisk * 0.4),
    maxFreeDiskBytes: Math.floor(free * 0.2)
  };
  const recommendationLimitBytes = Math.min(recommendationCaps.maxTotalDiskBytes, recommendationCaps.maxFreeDiskBytes);
  const recommendedProfiles = profiles
    .filter((profile) => Number(profile.preparedSizeBytes ?? profile.expectedSizeBytes ?? 0) <= recommendationLimitBytes)
    .map((profile) => ({
      id: profile.id,
      title: profile.title,
      fitsDisk: Number(profile.preparedSizeBytes ?? profile.expectedSizeBytes ?? 0) <= recommendationLimitBytes,
      expectedSizeBytes: profile.expectedSizeBytes,
      preparedSizeBytes: profile.preparedSizeBytes ?? profile.expectedSizeBytes,
      diskBudgetGb: profile.disk_budget_gb,
      recommendationLimitBytes
    }));
  const recommendedProfile = recommendedProfiles[recommendedProfiles.length - 1] ?? null;
  return {
    platform: os.platform(),
    arch: os.arch(),
    cpuCount,
    totalMemBytes: totalMem,
    availableMemBytes: memory.availableBytes,
    freeMemBytes: memory.freeBytes,
    swapTotalBytes: memory.swapTotalBytes,
    swapFreeBytes: memory.swapFreeBytes,
    totalDiskBytes: totalDisk,
    freeSpaceBytes: free,
    recommendationCaps,
    recommendationLimitBytes,
    tier,
    recommendedProfile,
    recommendedProfiles,
    aiRecommendation: recommendAi(totalMem, models)
  };
}

function classifyTier(memoryBytes, freeBytes) {
  const gb = memoryBytes / 1024 ** 3;
  const diskGb = freeBytes / 1024 ** 3;
  if (gb >= 32 && diskGb >= 512) return "rebuild-workstation";
  if (gb >= 16 && diskGb >= 128) return "core-ai";
  if (gb >= 8 && diskGb >= 64) return "survival-ai";
  return "browse-only";
}

export function recommendAi(memoryBytes, models = []) {
  const gb = memoryBytes / 1024 ** 3;
  const preferred = gb >= 32
    ? ["mistral-small", "qwen3:8b", "bge-m3"]
    : gb >= 16
      ? ["qwen3:8b", "bge-m3"]
      : gb >= 8
        ? ["gemma3:4b", "nomic-embed-text"]
        : [];
  if (!models.length) return preferred;

  const safeBudget = memoryBytes;
  return preferred.filter((name) => {
    const model = models.find((item) => item.id === name || item.pull === name);
    return model && estimateModelRamBytes(model) <= safeBudget;
  });
}

export async function freeSpaceBytes(target) {
  return (await diskSpaceBytes(target)).free;
}

export async function memorySnapshot() {
  if (process.platform === "linux") {
    try {
      const data = await fs.readFile("/proc/meminfo", "utf8");
      const values = new Map();
      for (const line of data.split("\n")) {
        const match = /^([A-Za-z_()]+):\s+(\d+)\s+kB$/.exec(line.trim());
        if (match) values.set(match[1], Number(match[2]) * 1024);
      }
      return {
        totalBytes: values.get("MemTotal") ?? os.totalmem(),
        availableBytes: values.get("MemAvailable") ?? os.freemem(),
        freeBytes: values.get("MemFree") ?? os.freemem(),
        swapTotalBytes: values.get("SwapTotal") ?? 0,
        swapFreeBytes: values.get("SwapFree") ?? 0
      };
    } catch {
      // Fall through to the portable Node.js values below.
    }
  }
  return {
    totalBytes: os.totalmem(),
    availableBytes: os.freemem(),
    freeBytes: os.freemem(),
    swapTotalBytes: 0,
    swapFreeBytes: 0
  };
}

export function estimateModelRamBytes(model) {
  const modelBytes = Number(model?.expected_size_bytes ?? 0);
  if (!modelBytes) return 10 * 1024 ** 3;
  if (model?.role === "embedding") {
    return Math.ceil(Math.max(3 * 1024 ** 3, modelBytes * 1.2 + 1536 * 1024 ** 2));
  }
  const overheadBytes = modelBytes >= 12 * 1024 ** 3 ? 5 * 1024 ** 3 : 3 * 1024 ** 3;
  const multiplier = modelBytes >= 12 * 1024 ** 3 ? 1.45 : 1.35;
  return Math.ceil(Math.max(6 * 1024 ** 3, modelBytes * multiplier + overheadBytes));
}

export async function diskSpaceBytes(target) {
  await fs.mkdir(target, { recursive: true });
  const stats = await fs.statfs(target);
  return {
    free: Number(stats.bavail) * Number(stats.bsize),
    total: Number(stats.blocks) * Number(stats.bsize)
  };
}

export function openPath(file) {
  if (process.env.SCA_NO_OPEN === "1") return { opened: file, suppressed: true };
  const opener = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", file] : [file];
  const child = spawn(opener, args, { detached: true, stdio: "ignore" });
  child.unref();
  return { opened: file };
}
