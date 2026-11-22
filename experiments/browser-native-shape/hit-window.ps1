param([int]$OpaqueX, [int]$OpaqueY, [int]$HoleX, [int]$HoleY)
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class CateShapeProbe {
  [StructLayout(LayoutKind.Sequential)]
  public struct POINT {
    public int X;
    public int Y;
  }
  [DllImport("user32.dll")]
  public static extern IntPtr WindowFromPoint(POINT point);
  [DllImport("user32.dll")]
  public static extern IntPtr GetAncestor(IntPtr window, uint flag);
  [DllImport("user32.dll")]
  public static extern bool SetProcessDpiAwarenessContext(IntPtr context);
  public static long At(int x, int y) {
    IntPtr target = WindowFromPoint(new POINT { X = x, Y = y });
    return GetAncestor(target, 2).ToInt64();
  }
}
'@
[CateShapeProbe]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null
@{
  opaque = [CateShapeProbe]::At($OpaqueX, $OpaqueY).ToString()
  hole = [CateShapeProbe]::At($HoleX, $HoleY).ToString()
} | ConvertTo-Json -Compress
