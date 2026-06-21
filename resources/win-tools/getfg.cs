using System;
using System.Runtime.InteropServices;
class P {
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    static void Main() { Console.Write(GetForegroundWindow().ToInt64()); }
}
