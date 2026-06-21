using System;
using System.Runtime.InteropServices;
using System.Threading;
class P {
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr hWnd);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
    [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();

    const ushort VK_CONTROL = 0x11;
    const ushort VK_V = 0x56;
    const ushort VK_MENU = 0x12;
    const uint INPUT_KEYBOARD = 1;
    const uint KEYEVENTF_KEYUP = 0x0002;

    [StructLayout(LayoutKind.Sequential)]
    struct MOUSEINPUT {
        public int dx;
        public int dy;
        public uint mouseData;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct KEYBDINPUT {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }
    [StructLayout(LayoutKind.Explicit)]
    struct INPUTUNION {
        [FieldOffset(0)] public KEYBDINPUT ki;
        [FieldOffset(0)] public MOUSEINPUT mi;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct INPUT {
        public uint type;
        public INPUTUNION u;
    }

    static INPUT KeyDown(ushort vk) {
        INPUT i = new INPUT(); i.type = INPUT_KEYBOARD; i.u.ki.wVk = vk; return i;
    }
    static INPUT KeyUp(ushort vk) {
        INPUT i = new INPUT(); i.type = INPUT_KEYBOARD; i.u.ki.wVk = vk; i.u.ki.dwFlags = KEYEVENTF_KEYUP; return i;
    }

    static void ForceForeground(IntPtr hwnd) {
        IntPtr fgWnd = GetForegroundWindow();
        if (fgWnd == hwnd) return;

        uint fgPid;
        uint fgThread = GetWindowThreadProcessId(fgWnd, out fgPid);
        uint ourThread = GetCurrentThreadId();
        bool attached = false;

        if (fgThread != ourThread) {
            attached = AttachThreadInput(ourThread, fgThread, true);
        }

        INPUT[] altFlash = new INPUT[] { KeyDown(VK_MENU), KeyUp(VK_MENU) };
        SendInput(2, altFlash, Marshal.SizeOf(typeof(INPUT)));

        if (IsIconic(hwnd))
            ShowWindow(hwnd, 9);
        else if (IsZoomed(hwnd))
            ShowWindow(hwnd, 3);
        else
            ShowWindow(hwnd, 5);
        SetForegroundWindow(hwnd);

        if (attached) AttachThreadInput(ourThread, fgThread, false);
    }

    static void Main(string[] args) {
        if (args.Length < 1) { Console.Error.Write("Usage: setfg <hwnd> [nopaste]"); Environment.Exit(1); }
        IntPtr hwnd = new IntPtr(long.Parse(args[0]));
        bool paste = !(args.Length > 1 && args[1] == "nopaste");

        ForceForeground(hwnd);
        Thread.Sleep(120);

        if (paste) {
            INPUT[] inputs = new INPUT[] {
                KeyDown(VK_CONTROL),
                KeyDown(VK_V),
                KeyUp(VK_V),
                KeyUp(VK_CONTROL),
            };
            SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
            Thread.Sleep(100);
        }
    }
}
