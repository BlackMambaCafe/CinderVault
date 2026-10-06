// Optional Windows-only sidecar for separate native caption and large icons.
// It targets exactly the HWND, PID and EXE supplied by its owning application.
// Icons are kept alive until that specific window closes; no desktop scanning.
using System;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

internal static class WindowIcons
{
    const uint WM_SETICON = 0x0080, WM_GETICON = 0x007F;
    const uint IMAGE_ICON = 1, LR_LOADFROMFILE = 0x0010;
    const uint SMTO_ABORTIFHUNG = 0x0002;
    [DllImport("user32.dll", SetLastError = true)]
    static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll", SetLastError = true)]
    static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr LoadImageW(IntPtr instance, string name, uint type, int width, int height, uint flags);
    [DllImport("user32.dll", SetLastError = true)]
    static extern bool DestroyIcon(IntPtr icon);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr SendMessageTimeoutW(IntPtr hwnd, uint message, UIntPtr wParam, IntPtr lParam,
                                           uint flags, uint timeout, out UIntPtr result);
    [DllImport("user32.dll")]
    static extern uint GetDpiForWindow(IntPtr hwnd);
    [DllImport("user32.dll")]
    static extern int GetSystemMetricsForDpi(int index, uint dpi);

    static string Escape(string value)
    { return value.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", "\\r").Replace("\n", "\\n"); }

    static void Report(string path, string text)
    {
        if (String.IsNullOrEmpty(path)) return;
        string folder = Path.GetDirectoryName(Path.GetFullPath(path));
        if (!Directory.Exists(folder)) Directory.CreateDirectory(folder);
        File.WriteAllText(path, text + Environment.NewLine, new UTF8Encoding(false));
    }

    static UIntPtr Send(IntPtr hwnd, uint message, uint kind, IntPtr icon)
    {
        UIntPtr result;
        if (SendMessageTimeoutW(hwnd, message, new UIntPtr(kind), icon, SMTO_ABORTIFHUNG, 2000, out result) == IntPtr.Zero)
            throw new InvalidOperationException("Window icon message failed or timed out: " + Marshal.GetLastWin32Error());
        return result;
    }

    static bool OwnedWindow(IntPtr hwnd, int processId)
    {
        uint actualPid;
        return IsWindow(hwnd) && GetWindowThreadProcessId(hwnd, out actualPid) != 0 && actualPid == processId;
    }

    // Arguments: decimal HWND, decimal PID, expected EXE path, small .ico, big .ico,
    // optional report path. Launch with windowsHide:true (binary is also /winexe).
    [STAThread]
    static int Main(string[] args)
    {
        string report = args.Length == 6 ? args[5] : null;
        IntPtr small = IntPtr.Zero, large = IntPtr.Zero;
        IntPtr targetWindow = IntPtr.Zero, oldSmall = IntPtr.Zero, oldLarge = IntPtr.Zero;
        int targetPid = 0;
        bool smallAttached = false, largeAttached = false;
        try
        {
            if (args.Length != 5 && args.Length != 6)
                throw new ArgumentException("Expected HWND PID EXE SMALL_ICO BIG_ICO [REPORT]");
            IntPtr hwnd = new IntPtr(Int64.Parse(args[0], CultureInfo.InvariantCulture));
            int processId = Int32.Parse(args[1], CultureInfo.InvariantCulture);
            targetWindow = hwnd;
            targetPid = processId;
            string expectedExe = Path.GetFullPath(args[2]);
            string smallFile = Path.GetFullPath(args[3]), largeFile = Path.GetFullPath(args[4]);
            if (!OwnedWindow(hwnd, processId)) throw new InvalidOperationException("HWND does not belong to the supplied process");
            using (Process target = Process.GetProcessById(processId))
            {
                if (!String.Equals(Path.GetFullPath(target.MainModule.FileName), expectedExe, StringComparison.OrdinalIgnoreCase))
                    throw new InvalidOperationException("Target process executable does not match");
                if (!File.Exists(smallFile) || !File.Exists(largeFile)) throw new FileNotFoundException("Icon file is missing");
                uint dpi = GetDpiForWindow(hwnd);
                if (dpi == 0) dpi = 96;
                small = LoadImageW(IntPtr.Zero, smallFile, IMAGE_ICON,
                                   GetSystemMetricsForDpi(49, dpi), GetSystemMetricsForDpi(50, dpi), LR_LOADFROMFILE);
                large = LoadImageW(IntPtr.Zero, largeFile, IMAGE_ICON,
                                   GetSystemMetricsForDpi(11, dpi), GetSystemMetricsForDpi(12, dpi), LR_LOADFROMFILE);
                if (small == IntPtr.Zero || large == IntPtr.Zero)
                    throw new InvalidOperationException("Could not load Windows icon: " + Marshal.GetLastWin32Error());
                if (!OwnedWindow(hwnd, processId)) throw new InvalidOperationException("Target window closed before icon update");
                oldSmall = new IntPtr(unchecked((long)Send(hwnd, WM_SETICON, 0, small).ToUInt64()));
                smallAttached = true;
                oldLarge = new IntPtr(unchecked((long)Send(hwnd, WM_SETICON, 1, large).ToUInt64()));
                largeAttached = true;
                ulong actualSmall = Send(hwnd, WM_GETICON, 0, IntPtr.Zero).ToUInt64();
                ulong actualLarge = Send(hwnd, WM_GETICON, 1, IntPtr.Zero).ToUInt64();
                if (actualSmall != unchecked((ulong)small.ToInt64()) || actualLarge != unchecked((ulong)large.ToInt64()))
                    throw new InvalidOperationException("Window did not retain the supplied icon handles");
                Report(report, "{\"status\":\"ready\",\"pid\":" + processId + ",\"hwnd\":\"" + args[0]
                       + "\",\"small\":\"" + Escape(Path.GetFileName(smallFile)) + "\",\"large\":\""
                       + Escape(Path.GetFileName(largeFile)) + "\",\"dpi\":" + dpi
                       + ",\"smallHandle\":\"" + actualSmall + "\",\"largeHandle\":\"" + actualLarge
                       + "\",\"wmGetIconMatches\":true}");
                // HICON handles created here must stay alive while attached.
                while (!target.WaitForExit(500) && OwnedWindow(hwnd, processId)) { }
            }
            return 0;
        }
        catch (Exception error)
        {
            try { Report(report, "{\"status\":\"error\",\"message\":\"" + Escape(error.Message) + "\"}"); }
            catch { }
            return 1;
        }
        finally
        {
            // A partial failure must not leave a surviving window holding our
            // soon-to-be-destroyed icons. Restore only handles still owned here.
            if (OwnedWindow(targetWindow, targetPid))
            {
                try
                {
                    if (smallAttached && Send(targetWindow, WM_GETICON, 0, IntPtr.Zero).ToUInt64() == unchecked((ulong)small.ToInt64()))
                        Send(targetWindow, WM_SETICON, 0, oldSmall);
                    if (largeAttached && Send(targetWindow, WM_GETICON, 1, IntPtr.Zero).ToUInt64() == unchecked((ulong)large.ToInt64()))
                        Send(targetWindow, WM_SETICON, 1, oldLarge);
                }
                catch { }
            }
            if (small != IntPtr.Zero) DestroyIcon(small);
            if (large != IntPtr.Zero) DestroyIcon(large);
        }
    }
}
