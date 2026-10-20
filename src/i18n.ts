export type Lang = 'en' | 'zh';

export const STRINGS = {
  en: {
    // ===== Hero / nav =====
    // (eyebrow / heroTitle* / lead / ctaConnect / ctaHow / badges /
    //  navDocs removed in v0.3.1 — the user asked for a leaner page
    //  with no marketing copy. Only the language switcher remains in
    //  the header.)
    footer1: 'Meshnology · Web Flasher',
        footer2: 'Firmware never leaves this device · MIT License',

        // ===== 16302-style page head + two-column file box =====
        pageTitle: 'Firmware Flashing Tool',
        pageDesc: 'Flash local firmware straight from the browser with no extra software — supports the whole ESP32 family over Web Serial.',
        colDevice: 'Connect device',
        colFirmware: 'Select firmware',
        burnSingle: 'Flash single file',
        burnMulti: 'Flash multi file',

    // ===== Step 1: Connect serial port =====
    step1Label: 'Step 01',
    step1Title: 'Connect your board',
    step1Desc: 'Use Chrome or Edge. Web Serial will prompt you to pick a USB-UART port (CH340, CP210x, FTDI, ESP32-S3 native USB, etc.).',
    step1Btn: 'Choose serial port',
    step1StatusDisc: 'Disconnected',
    step1StatusConn: 'Connected',
    step1StatusUnsup: 'Browser unsupported',
    step1LogChoose: 'Click "Choose serial port" to begin.',
    step1LogGranted: 'Port opened. Vendor: ',
    step1LogCancelled: 'Port selection cancelled.',
    step1LogFail: 'Cannot open port. Close other serial monitors and retry.',
    step1LogBoot: 'If the board is not detected, hold the <b>BOOT</b> button while plugging it in.',

    // ===== Step 2: Pick firmware (mode A: upload | mode B: catalog) =====
    step2Label: 'Step 02',
    step2Title: 'Pick firmware',
    step2DescUpload: 'Drop a single .bin file. esptool-js will auto-detect the chip after you connect.',
    step2DescCatalog: 'Firmware for this device comes from the prebuilt catalog. SHA-256 is verified before flashing.',
    tabSingle: 'Single merged .bin',
    tabMulti: 'Multiple files + offsets',
    dropTitle: 'Drop .bin files here',
    dropBrowse: 'browse from your computer',
    dropEmpty: 'No file selected yet.',
    browseCatalog: '…or pick from the device catalog',
        useLocalBin: '…or use a local .bin file',
        // v0.3.3: browseCatalog / useLocalBin are no longer referenced — the
        // ghost "...or pick from the device catalog" button was replaced by
        // a real two-tab source switch (srcUpload / srcCatalog).
        srcUpload: 'Local upload',
        srcCatalog: 'Pick a device',
    catalogDeviceLabel: 'Device',
    catalogVersionLabel: 'Firmware version',
    catalogLoading: 'Loading catalog…',
    catalogEmpty: 'No devices in the catalog yet.',
    catalogDeviceMissing: 'Device not found. Pick another.',
    catalogVersionMissing: 'Version not found. Showing latest 5.',
    catalogBackToPicker: '← back to device list',
    catalogPickAnother: 'Pick another version',
    catalogBack: '← switch mode',
    catalogSelected: (deviceName: string, version: string, sizeMB: string) =>
      `${deviceName} · ${version} · ${sizeMB} MB`,
    configTitle: 'Flash parameters',
    configMode: 'Mode',
    configFreq: 'Frequency',
    configSize: 'Flash size',
    configAuto: 'Auto',
    configHint: 'Defaults are ESP32-S3 safe (DIO / 80 MHz / 16 MB). Pick "Auto" only if your chip reports those values on its own.',

    // ===== Step 3: Flash + terminal =====
    step3Label: 'Step 03',
    step3Title: 'Flash & monitor',
    step3Desc: 'Live output from esptool runs in the terminal below. Do not unplug during flashing.',
    chipLabel: 'Chip',
    chipUnknown: '— (connect first)',
    flashBtn: 'Start flashing',
    flashBtnCatalog: (version: string) => `Flash ${version}`,
    abortBtn: 'Cancel',
    progressIdle: 'Ready.',
    progressConnecting: 'Opening serial port…',
    progressSyncing: 'Synchronizing with ROM bootloader…',
    progressDetecting: 'Detecting chip…',
    progressErasing: 'Erasing flash…',
    progressWriting: 'Writing',
    progressVerifying: 'Verifying…',
    progressRestarting: 'Restarting board…',
    progressDone: 'Done.',
    progressCancelled: 'Cancelled.',
    progressEmpty: 'Add a firmware file and connect a board to begin.',
    progressFetching: (sizeMB: string) => `Fetching firmware (${sizeMB} MB) and verifying SHA-256…`,
    terminalLabel: 'Terminal',
    terminalEmpty: 'No output yet.',

    // ===== Errors =====
    errBrowserUnsupported: 'Web Serial not available. Use Chrome 89+ or Edge 89+.',
    errNoPort: 'Connect a serial port first.',
    errNoFirmware: 'Add a .bin file first.',
    errSyncTimeout: 'ROM sync failed. Hold BOOT while plugging in, then retry.',
    errChipUnknown: 'Unknown chip — esptool.js could not identify this device.',
    errBinTooLarge: 'Firmware exceeds detected flash size.',
    errErase: 'Flash erase failed.',
    errWrite: 'Flash write failed.',
    errVerify: 'MD5 verification failed.',
    errPortDisconnect: 'Serial port disconnected during flash.',
    errAborted: 'Cancelled by user.',
    errPortAlreadyOpen: 'Serial port is already open. Close other apps using it (Arduino IDE, PuTTY, etc.) and retry.',
    errCatalogLoad: 'Failed to load the firmware catalog. Check your network and try again.',
    errCatalogInvalid: 'Catalog entry is invalid (bad version or sha256).',
    errFirmwareCorrupted: 'Firmware SHA-256 does not match the catalog entry. Refusing to flash.',
    errBinSizeMismatch: 'Downloaded size does not match the catalog. CDN may be serving a stale file.',
    errBinMissing: 'Firmware .bin is in the catalog but not in the deployment. Report this to the owner.',

    // ===== Misc =====
    removeAria: 'Remove',
    offsetLabel: 'offset',
    filesCount: (n: number) => `${n} file${n > 1 ? 's' : ''}`,
    bytes: (s: string, n: number) => `${s} · ${n}`,
    formatProgress: (written: number, total: number) => {
      const w = written < 1024 ? `${written} B` : `${(written / 1024 / 1024).toFixed(2)} MB`;
      const t = total < 1024 ? `${total} B` : `${(total / 1024 / 1024).toFixed(2)} MB`;
      const pct = total > 0 ? Math.floor((written / total) * 100) : 0;
      return `${w} / ${t} (${pct}%)`;
    },
    formatMb: (bytes: number) => `${(bytes / 1024 / 1024).toFixed(2)} MB`,
  },
  zh: {
    // ===== Hero / nav =====
    // (eyebrow / heroTitle* / lead / ctaConnect / ctaHow / badges /
    //  navDocs removed — see en above.)
    footer1: 'Meshnology · 网页烧录',
        footer2: '固件不会离开此设备 · MIT 开源',

        // ===== 16302 风格页头 + 双列 file-box =====
        pageTitle: '本地固件烧录工具',
        pageDesc: '无需安装任何软件，直接在浏览器里把本地固件烧录到设备中，支持 ESP32 全系芯片。',
        colDevice: '连接设备',
        colFirmware: '选择固件文件',
        burnSingle: '单文件烧录',
        burnMulti: '多文件烧录',

    // ===== Step 1: Connect serial port =====
    step1Label: '步骤 01',
    step1Title: '连接开发板',
    step1Desc: '请使用 Chrome 或 Edge。Web Serial 会弹出串口选择器（支持 CH340、CP210x、FTDI、ESP32-S3 原生 USB 等）。',
    step1Btn: '选择串口',
    step1StatusDisc: '未连接',
    step1StatusConn: '已连接',
    step1StatusUnsup: '浏览器不支持',
    step1LogChoose: '点击"选择串口"开始。',
    step1LogGranted: '串口已打开。芯片厂商：',
    step1LogCancelled: '已取消串口选择。',
    step1LogFail: '无法打开串口。请先关闭其他串口监视器后重试。',
    step1LogBoot: '若设备未被识别，请按住 <b>BOOT</b> 键后重新插入设备。',

    // ===== Step 2: Pick firmware (mode A: upload | mode B: catalog) =====
    step2Label: '步骤 02',
    step2Title: '选择固件',
    step2DescUpload: '拖入一个 .bin 文件。连接设备后 esptool-js 会自动识别芯片型号。',
    step2DescCatalog: '该设备的固件来自预置目录。SHA-256 会在烧录前自动校验。',
    tabSingle: '单个合并 .bin',
    tabMulti: '多个文件 + 偏移',
    dropTitle: '拖放 .bin 文件到这里',
    dropBrowse: '从电脑选择',
    dropEmpty: '尚未选择文件。',
    browseCatalog: '…或从设备目录中选择',
        useLocalBin: '…或使用本地 .bin 文件',
        // 见上方 en 说明：browseCatalog / useLocalBin 已不再被引用
        srcUpload: '本地上传',
        srcCatalog: '选择设备',
    catalogDeviceLabel: '设备',
    catalogVersionLabel: '固件版本',
    catalogLoading: '正在加载目录…',
    catalogEmpty: '目录中暂无设备。',
    catalogDeviceMissing: '未找到该设备，请选择其他。',
    catalogVersionMissing: '未找到该版本，显示最近 5 个。',
    catalogBackToPicker: '← 返回设备列表',
    catalogPickAnother: '选择其他版本',
    catalogBack: '← 切换模式',
    catalogSelected: (deviceName: string, version: string, sizeMB: string) =>
      `${deviceName} · ${version} · ${sizeMB} MB`,
    configTitle: 'Flash 参数',
    configMode: '模式',
    configFreq: '频率',
    configSize: '容量',
    configAuto: '自动',
    configHint: '默认是 ESP32-S3 安全值（DIO / 80 MHz / 16 MB）。只有当芯片自动报告这些值时才选"自动"。',

    // ===== Step 3: Flash + terminal =====
    step3Label: '步骤 03',
    step3Title: '烧录与监控',
    step3Desc: 'esptool 的实时输出显示在下方终端。烧录过程中请勿断开连接。',
    chipLabel: '芯片',
    chipUnknown: '—（请先连接）',
    flashBtn: '开始烧录',
    flashBtnCatalog: (version: string) => `烧录 ${version}`,
    abortBtn: '取消',
    progressIdle: '就绪。',
    progressConnecting: '正在打开串口…',
    progressSyncing: '正在与 ROM bootloader 同步…',
    progressDetecting: '正在识别芯片…',
    progressErasing: '正在擦除 flash…',
    progressWriting: '正在写入',
    progressVerifying: '正在校验…',
    progressRestarting: '正在重启开发板…',
    progressDone: '完成。',
    progressCancelled: '已取消。',
    progressEmpty: '请选择固件文件并连接开发板。',
    progressFetching: (sizeMB: string) => `正在下载固件（${sizeMB} MB）并校验 SHA-256…`,
    terminalLabel: '终端',
    terminalEmpty: '暂无输出。',

    // ===== Errors =====
    errBrowserUnsupported: '当前浏览器不支持 Web Serial。请使用 Chrome 89+ 或 Edge 89+。',
    errNoPort: '请先连接串口。',
    errNoFirmware: '请先选择 .bin 文件。',
    errSyncTimeout: 'ROM 同步失败。请按住 BOOT 键后重新插入设备再试。',
    errChipUnknown: '无法识别芯片 —— esptool-js 未能确认设备型号。',
    errBinTooLarge: '固件超出检测到的 flash 容量。',
    errErase: 'Flash 擦除失败。',
    errWrite: 'Flash 写入失败。',
    errVerify: 'MD5 校验失败。',
    errPortDisconnect: '烧录过程中串口已断开。',
    errAborted: '已取消。',
    errPortAlreadyOpen: '串口已被其他程序占用（Arduino IDE / PuTTY 等）。请关闭后重试。',
    errCatalogLoad: '目录加载失败。请检查网络后重试。',
    errCatalogInvalid: '目录项无效（版本号或 SHA-256 错误）。',
    errFirmwareCorrupted: '固件 SHA-256 与目录项不一致。拒绝烧录。',
    errBinSizeMismatch: '下载大小与目录项不一致，CDN 可能返回了旧文件。',
    errBinMissing: '固件 .bin 在目录中但部署里没有。请联系作者。',

    // ===== Misc =====
    removeAria: '移除',
    offsetLabel: '地址',
    filesCount: (n: number) => `${n} 个文件`,
    bytes: (s: string, n: number) => `${s} · ${n}`,
    formatProgress: (written: number, total: number) => {
      const w = written < 1024 ? `${written} B` : `${(written / 1024 / 1024).toFixed(2)} MB`;
      const t = total < 1024 ? `${total} B` : `${(total / 1024 / 1024).toFixed(2)} MB`;
      const pct = total > 0 ? Math.floor((written / total) * 100) : 0;
      return `${w} / ${t} (${pct}%)`;
    },
    formatMb: (bytes: number) => `${(bytes / 1024 / 1024).toFixed(2)} MB`,
  },
};
