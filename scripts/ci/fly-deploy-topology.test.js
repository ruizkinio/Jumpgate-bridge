"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const { spawn, spawnSync } = require("node:child_process");
const { PassThrough } = require("node:stream");
const { test } = require("node:test");
const {
  deriveObjectId,
  deriveResourceId,
  deriveSequenceId,
} = require("./s3-protocol-harness");
const { assertRubyPsych } = require("./tooling-prerequisites");

const ROOT = path.resolve(__dirname, "../..");
const WORKFLOW_PATH = path.join(ROOT, ".github/workflows/fly-deploy.yml");
const HELPER_PATH = path.join(__dirname, "container-smoke-topology.sh");
const WORKFLOW_PARSER = path.join(__dirname, "workflow-topology-contract.rb");
const HELPER_INVOCATION = "bash scripts/ci/container-smoke-topology.sh";
const STEP_NAME = "Validate the exact image against isolated production protocols";
const VERSION_PARITY_INVOCATION =
  "node scripts/ci/verify-kodi-version-parity.js .ci/kodi/xbmc/platform/android/activity/XBMCApp.h";
const KODI_PIN_VALIDATION_RUN =
  'test "$KODI_REPOSITORY" = "ruizkinio/Jumpgate-kodi"\n' +
  'test "$KODI_SHA" = "06228da12a066944772fa9951652a620b6e0b95c"\n';
const FINGERPRINT_PARITY_RUN =
  'test "$(git -C .ci/kodi rev-parse HEAD)" = "$KODI_SHA"\n' +
  'test -f "$JUMPGATE_KODI_FINGERPRINT_FIXTURE"\n' +
  `${VERSION_PARITY_INVOCATION}\n` +
  "node scripts/ci/node-test-gate.js \\\n" +
  "  --minimum-tests=1 \\\n" +
  "  --no-skips \\\n" +
  "  -- \\\n" +
  "  test/source-fingerprint-fixtures.test.js\n";
const DEPLOY_IF =
  "github.ref == 'refs/heads/main' && github.ref_protected == true && " +
  "(github.event_name == 'push' ||\n " +
  "(github.event_name == 'workflow_dispatch' && inputs.deploy))";
const GITHUB_SHA = "0123456789abcdef0123456789abcdef01234567";
const DEADLINE_EARLY_TOLERANCE_MS = 25;
const TOPOLOGY_COMPLETION_BOUND_MS = process.platform === "win32" ? 90000 : 30000;
const TOPOLOGY_FAILURE_DEADLINE_MS = process.platform === "win32" ? 60000 : 15000;
const TOPOLOGY_RUN_DEADLINE_MS = process.platform === "win32" ? 120000 : 60000;
const PROCESS_TREE_TERMINATION_GRACE_MS = process.platform === "win32" ? 7000 : 5000;
const PROCESS_TREE_FORCE_FINISH_MS = process.platform === "win32" ? 3500 : 5000;
const PROCESS_TREE_TERMINATION_RETRY_MS = 1000;
const WINDOWS_PROCESS_SNAPSHOT_TIMEOUT_MS = 2000;
const WINDOWS_PROCESS_VERIFY_RETRY_MS = 25;
const MAX_UINT32 = 0xffffffff;
const DEADLINE_READY_POLL_MS = 10;
const EXPECTED_VERSION = require(path.join(ROOT, "package.json")).version;
const REDIS_7_IMAGE =
  "redis:7-alpine@sha256:6ab0b6e7381779332f97b8ca76193e45b0756f38d4c0dcda72dbb3c32061ab99";
const REDIS_8_IMAGE =
  "redis:8.2-alpine@sha256:223b183cbc49f5ff48728e1fc52ccf101f05072decad2bd9867281a3c9bf75fd";
const POSTGRES_16_IMAGE =
  "postgres:16-alpine@sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777";
const POSTGRES_17_IMAGE =
  "postgres:17-alpine@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193";
const IMAGES = Object.freeze({
  node: "node:24-alpine@sha256:" + "a".repeat(64),
  postgres: "postgres:17-alpine@sha256:" + "b".repeat(64),
  redis: "redis:8.2-alpine@sha256:" + "c".repeat(64),
});
const WORKFLOW_ENV = Object.freeze({
  NODE_VERSION: "24",
  KODI_REPOSITORY: "ruizkinio/Jumpgate-kodi",
  KODI_SHA: "06228da12a066944772fa9951652a620b6e0b95c",
  ACTIONLINT_VERSION: "1.7.9",
  ACTIONLINT_LINUX_AMD64_SHA256:
    "233b280d05e100837f4af1433c7b40a5dcb306e3aa68fb4f17f8a7f45a7df7b4",
  SHELLCHECK_VERSION: "0.11.0",
  SHELLCHECK_LINUX_X86_64_SHA256:
    "b7af85e41cc99489dcc21d66c6d5f3685138f06d34651e6d34b42ec6d54fe6f6",
  FLYCTL_VERSION: "0.4.69-jumpgate-digest4",
  FLYCTL_ARCHIVE_URL:
    "https://github.com/ruizkinio/flyctl/releases/download/jumpgate-flyctl-v0.4.69-digest4/flyctl_0.4.69-jumpgate-digest4_Linux_x86_64.tar.gz",
  FLYCTL_LINUX_X86_64_SHA256:
    "d9f1a798980f50a3091aaad60956b35f3c7a2795677287d5257fac876137da80",
  FLYCTL_LINUX_X86_64_BINARY_SHA256:
    "70afd975429f8fad178ed2aeab936883d7162a2526311db9746f14e5bf69c783",
  FLYCTL_SOURCE_COMMIT: "cc9795507584be17cad4d15af0752195af4c403d",
  FLYCTL_BUILD_DATE: "2026-07-19T02:19:27+02:00",
  CONTAINER_NODE_IMAGE:
    "node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd",
  CONTAINER_POSTGRES_IMAGE: POSTGRES_17_IMAGE,
  CONTAINER_REDIS_IMAGE: REDIS_8_IMAGE,
});
const RELEASE_IF =
  "success() && github.ref == 'refs/heads/main' && github.ref_protected == true && " +
  "(github.event_name == 'push' ||\n " +
  "(github.event_name == 'workflow_dispatch' && inputs.deploy))";
const BUILD_RUN =
  'docker build --pull \\\n' +
  '  --build-arg "JUMPGATE_BUILD_SHA=$GITHUB_SHA" \\\n' +
  '  --tag "jumpgate-bridge:$GITHUB_SHA" \\\n' +
  "  .\n" +
  "test \"$(docker image inspect --format '{{index .Config.Labels \"org.opencontainers.image.revision\"}}' " +
  '"jumpgate-bridge:$GITHUB_SHA")" = "$GITHUB_SHA"\n' +
  "test \"$(docker image inspect --format '{{.Config.User}}' " +
  '"jumpgate-bridge:$GITHUB_SHA")" = "node"\n';
const EXPORT_RUN =
  'set -euo pipefail\n' +
  'artifact_dir="$RUNNER_TEMP/jumpgate-image"\n' +
  'mkdir -p "$artifact_dir"\n' +
  'docker save "jumpgate-bridge:$GITHUB_SHA" --output "$artifact_dir/jumpgate-image.tar"\n' +
  '(\n  cd "$artifact_dir"\n' +
  '  sha256sum jumpgate-image.tar > jumpgate-image.tar.sha256\n)\n' +
  'archive_sha256="$(sha256sum "$artifact_dir/jumpgate-image.tar" | cut -d \' \' -f 1)"\n' +
  '[[ "$archive_sha256" =~ ^[a-f0-9]{64}$ ]]\n' +
  'echo "archive-sha256=$archive_sha256" >> "$GITHUB_OUTPUT"\n';
const FLYCTL_VERIFY_RUN =
  'set -euo pipefail\n' +
  'tool_dir="$RUNNER_TEMP/flyctl-${FLYCTL_VERSION}"\n' +
  'archive="$RUNNER_TEMP/flyctl-${FLYCTL_VERSION}.tar.gz"\n' +
  'mkdir -p "$tool_dir"\n' +
  "curl --proto '=https' --tlsv1.2 --fail --silent --show-error --location \\\n" +
  '  --output "$archive" \\\n' +
  '  "$FLYCTL_ARCHIVE_URL"\n' +
  "printf '%s  %s\\n' \"$FLYCTL_LINUX_X86_64_SHA256\" \"$archive\" |\n" +
  '  sha256sum --check --strict\n' +
  'test "$(tar --list --gzip --file "$archive")" = "flyctl"\n' +
  'tar --extract --gzip --file "$archive" --directory "$tool_dir"\n' +
  "printf '%s  %s\\n' \"$FLYCTL_LINUX_X86_64_BINARY_SHA256\" \"$tool_dir/flyctl\" |\n" +
  '  sha256sum --check --strict\n' +
  'install -m 0755 "$tool_dir/flyctl" "$tool_dir/flyctl-verified"\n' +
  "printf '%s  %s\\n' \"$FLYCTL_LINUX_X86_64_BINARY_SHA256\" " +
  '"$tool_dir/flyctl-verified" |\n' +
  '  sha256sum --check --strict\n' +
  'version_output="$("$tool_dir/flyctl-verified" version 2>&1)"\n' +
  'test "$version_output" = \\\n' +
  '  "flyctl-verified v${FLYCTL_VERSION} linux/amd64 Commit: ' +
  '${FLYCTL_SOURCE_COMMIT} BuildDate: ${FLYCTL_BUILD_DATE}"\n' +
  'version_json_output="$("$tool_dir/flyctl-verified" version --json 2>&1)"\n' +
  'test "$version_json_output" = \\\n' +
  '  "{\\"Name\\":\\"flyctl-verified\\",\\"Version\\":\\"${FLYCTL_VERSION}\\",' +
  '\\"Commit\\":\\"${FLYCTL_SOURCE_COMMIT}\\",\\"BranchName\\":\\"\\",' +
  '\\"BuildDate\\":\\"${FLYCTL_BUILD_DATE}\\",\\"OS\\":\\"linux\\",' +
  '\\"Architecture\\":\\"amd64\\",\\"Environment\\":\\"production\\"}"\n' +
  'echo "FLYCTL_BIN=$tool_dir/flyctl-verified" >> "$GITHUB_ENV"\n';
const CLEANUP_CONTAINERS = Object.freeze([
  "jumpgate-http-smoke-ci",
  "jumpgate-http-smoke-ci-public",
  "jumpgate-bridge-ci",
  "jumpgate-bridge-ci-public",
  "jumpgate-s3-ci",
  "jumpgate-s3-ci-public",
  "jumpgate-postgres-ci",
  "jumpgate-redis-ci",
]);
const RUN_ORDER = Object.freeze([
  "jumpgate-postgres-ci",
  "jumpgate-redis-ci",
  "jumpgate-s3-ci",
  "jumpgate-release-transition-ci",
  "jumpgate-release-v6-ci",
  "jumpgate-bridge-ci",
  "jumpgate-http-smoke-ci",
  "jumpgate-s3-ci-public",
  "jumpgate-bridge-ci-public",
  "jumpgate-http-smoke-ci-public",
]);
const workflow = fs.readFileSync(WORKFLOW_PATH, "utf8").replace(/\r\n/g, "\n");
const helper = fs.readFileSync(HELPER_PATH, "utf8").replace(/\r\n/g, "\n");
const PARAMETER = "${";
const HANG_PROCESS_TREE_SCRIPT = [
  'const { spawn } = require("node:child_process");',
  'const fs = require("node:fs");',
  'const deepDescendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 300000)"],',
  '  { stdio: "inherit", windowsHide: true });',
  'fs.writeFileSync(process.env.JUMPGATE_TEST_HANG_PROCESS, JSON.stringify({',
  '  proofPids: [process.ppid, process.pid, deepDescendant.pid],',
  '}), { mode: 0o600 });',
  'setInterval(() => {}, 300000);',
].join(" ");
const WINDOWS_JOB_SUPERVISOR_SCRIPT = String.raw`
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
Remove-Item Env:JUMPGATE_JOB_SUPERVISOR_SOURCE -ErrorAction SilentlyContinue
$source = @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class JumpgateProcessSupervisor
{
    private const uint CREATE_SUSPENDED = 0x00000004;
    private const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
    private const uint STARTF_USESTDHANDLES = 0x00000100;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const uint HANDLE_FLAG_INHERIT = 0x00000001;
    private const int PROC_THREAD_ATTRIBUTE_HANDLE_LIST = 0x00020002;
    private const int PROC_THREAD_ATTRIBUTE_JOB_LIST = 0x0002000d;
    private const int JobObjectExtendedLimitInformation = 9;
    private const int STD_INPUT_HANDLE = -10;
    private const int STD_OUTPUT_HANDLE = -11;
    private const int STD_ERROR_HANDLE = -12;
    private const uint CLEANUP_WAIT_MS = 5000;
    private const uint INFINITE = 0xffffffff;
    private const uint WAIT_OBJECT_0 = 0;

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO
    {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public uint dwX;
        public uint dwY;
        public uint dwXSize;
        public uint dwYSize;
        public uint dwXCountChars;
        public uint dwYCountChars;
        public uint dwFillAttribute;
        public uint dwFlags;
        public ushort wShowWindow;
        public ushort cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public uint dwProcessId;
        public uint dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct STARTUPINFOEX
    {
        public STARTUPINFO StartupInfo;
        public IntPtr lpAttributeList;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr attributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetInformationJobObject(
        IntPtr job,
        int informationClass,
        ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION information,
        uint informationLength);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreateProcess(
        string applicationName,
        StringBuilder commandLine,
        IntPtr processAttributes,
        IntPtr threadAttributes,
        [MarshalAs(UnmanagedType.Bool)] bool inheritHandles,
        uint creationFlags,
        IntPtr environment,
        string currentDirectory,
        ref STARTUPINFOEX startupInfo,
        out PROCESS_INFORMATION processInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool InitializeProcThreadAttributeList(
        IntPtr attributeList,
        int attributeCount,
        int flags,
        ref IntPtr size);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool UpdateProcThreadAttribute(
        IntPtr attributeList,
        uint flags,
        IntPtr attribute,
        IntPtr value,
        IntPtr size,
        IntPtr previousValue,
        IntPtr returnSize);

    [DllImport("kernel32.dll")]
    private static extern void DeleteProcThreadAttributeList(IntPtr attributeList);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr thread);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool TerminateJobObject(IntPtr job, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool TerminateProcess(IntPtr process, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetHandleInformation(IntPtr handle, out uint flags);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetStdHandle(int standardHandle);

    private static Win32Exception LastError(string operation)
    {
        return new Win32Exception(Marshal.GetLastWin32Error(), operation + " failed");
    }

    private static IntPtr RequiredStandardHandle(int standardHandle)
    {
        IntPtr handle = GetStdHandle(standardHandle);
        if (handle == IntPtr.Zero || handle == new IntPtr(-1))
        {
            throw LastError("GetStdHandle");
        }
        return handle;
    }

    private static void RecordCleanupError(
        ref Win32Exception cleanupError,
        Win32Exception candidate)
    {
        if (cleanupError == null) cleanupError = candidate;
    }

    public static int Run(string applicationName, string commandLine, string currentDirectory)
    {
        IntPtr job = IntPtr.Zero;
        IntPtr attributeList = IntPtr.Zero;
        IntPtr jobList = IntPtr.Zero;
        IntPtr handleList = IntPtr.Zero;
        List<IntPtr> inheritedHandles = new List<IntPtr>();
        List<uint> originalHandleFlags = new List<uint>();
        PROCESS_INFORMATION process = new PROCESS_INFORMATION();
        bool attributeListInitialized = false;
        bool created = false;
        try
        {
            job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero) throw LastError("CreateJobObject");

            JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits =
                new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            uint limitsSize = (uint)Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
            if (!SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                ref limits,
                limitsSize))
            {
                throw LastError("SetInformationJobObject");
            }

            STARTUPINFOEX startup = new STARTUPINFOEX();
            startup.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
            startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
            startup.StartupInfo.hStdInput = RequiredStandardHandle(STD_INPUT_HANDLE);
            startup.StartupInfo.hStdOutput = RequiredStandardHandle(STD_OUTPUT_HANDLE);
            startup.StartupInfo.hStdError = RequiredStandardHandle(STD_ERROR_HANDLE);
            foreach (IntPtr handle in new IntPtr[] {
                startup.StartupInfo.hStdInput,
                startup.StartupInfo.hStdOutput,
                startup.StartupInfo.hStdError,
            })
            {
                if (inheritedHandles.Contains(handle)) continue;
                uint originalFlags;
                if (!GetHandleInformation(handle, out originalFlags))
                {
                    throw LastError("GetHandleInformation");
                }
                inheritedHandles.Add(handle);
                originalHandleFlags.Add(originalFlags);
                if (!SetHandleInformation(handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT))
                {
                    throw LastError("SetHandleInformation(inherit)");
                }
            }

            IntPtr attributeListSize = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref attributeListSize);
            if (attributeListSize == IntPtr.Zero)
            {
                throw LastError("InitializeProcThreadAttributeList(size)");
            }
            attributeList = Marshal.AllocHGlobal(attributeListSize);
            if (!InitializeProcThreadAttributeList(attributeList, 2, 0, ref attributeListSize))
            {
                throw LastError("InitializeProcThreadAttributeList");
            }
            attributeListInitialized = true;
            jobList = Marshal.AllocHGlobal(IntPtr.Size);
            Marshal.WriteIntPtr(jobList, job);
            if (!UpdateProcThreadAttribute(
                attributeList,
                0,
                new IntPtr(PROC_THREAD_ATTRIBUTE_JOB_LIST),
                jobList,
                new IntPtr(IntPtr.Size),
                IntPtr.Zero,
                IntPtr.Zero))
            {
                throw LastError("UpdateProcThreadAttribute(job)");
            }

            handleList = Marshal.AllocHGlobal(inheritedHandles.Count * IntPtr.Size);
            for (int index = 0; index < inheritedHandles.Count; index += 1)
            {
                Marshal.WriteIntPtr(handleList, index * IntPtr.Size, inheritedHandles[index]);
            }
            if (!UpdateProcThreadAttribute(
                attributeList,
                0,
                new IntPtr(PROC_THREAD_ATTRIBUTE_HANDLE_LIST),
                handleList,
                new IntPtr(inheritedHandles.Count * IntPtr.Size),
                IntPtr.Zero,
                IntPtr.Zero))
            {
                throw LastError("UpdateProcThreadAttribute(handles)");
            }

            startup.lpAttributeList = attributeList;
            created = CreateProcess(
                applicationName,
                new StringBuilder(commandLine),
                IntPtr.Zero,
                IntPtr.Zero,
                true,
                CREATE_SUSPENDED | EXTENDED_STARTUPINFO_PRESENT,
                IntPtr.Zero,
                currentDirectory,
                ref startup,
                out process);
            if (!created) throw LastError("CreateProcess");
            if (ResumeThread(process.hThread) == UInt32.MaxValue)
            {
                throw LastError("ResumeThread");
            }
            if (WaitForSingleObject(process.hProcess, INFINITE) != WAIT_OBJECT_0)
            {
                throw LastError("WaitForSingleObject");
            }
            uint exitCode;
            if (!GetExitCodeProcess(process.hProcess, out exitCode))
            {
                throw LastError("GetExitCodeProcess");
            }
            return unchecked((int)exitCode);
        }
        finally
        {
            Win32Exception cleanupError = null;
            // Close the Job first so kill-on-close tears down every assigned descendant.
            if (job != IntPtr.Zero)
            {
                if (!CloseHandle(job))
                {
                    RecordCleanupError(ref cleanupError, LastError("CloseHandle(job)"));
                    if (!TerminateJobObject(job, 72))
                    {
                        RecordCleanupError(ref cleanupError, LastError("TerminateJobObject"));
                    }
                    if (!CloseHandle(job))
                    {
                        RecordCleanupError(ref cleanupError, LastError("CloseHandle(job retry)"));
                    }
                }
            }
            if (created && WaitForSingleObject(process.hProcess, CLEANUP_WAIT_MS) != WAIT_OBJECT_0)
            {
                if (!TerminateProcess(process.hProcess, 72))
                {
                    RecordCleanupError(ref cleanupError, LastError("TerminateProcess"));
                }
                else if (WaitForSingleObject(process.hProcess, CLEANUP_WAIT_MS) != WAIT_OBJECT_0)
                {
                    RecordCleanupError(
                        ref cleanupError,
                        new Win32Exception("Process cleanup wait timed out"));
                }
            }
            for (int index = 0; index < inheritedHandles.Count; index += 1)
            {
                if (!SetHandleInformation(
                    inheritedHandles[index],
                    HANDLE_FLAG_INHERIT,
                    originalHandleFlags[index] & HANDLE_FLAG_INHERIT))
                {
                    RecordCleanupError(
                        ref cleanupError,
                        LastError("SetHandleInformation(restore)"));
                }
            }
            if (attributeListInitialized) DeleteProcThreadAttributeList(attributeList);
            if (handleList != IntPtr.Zero) Marshal.FreeHGlobal(handleList);
            if (jobList != IntPtr.Zero) Marshal.FreeHGlobal(jobList);
            if (attributeList != IntPtr.Zero) Marshal.FreeHGlobal(attributeList);
            if (process.hThread != IntPtr.Zero && !CloseHandle(process.hThread))
            {
                RecordCleanupError(ref cleanupError, LastError("CloseHandle(thread)"));
            }
            if (process.hProcess != IntPtr.Zero && !CloseHandle(process.hProcess))
            {
                RecordCleanupError(ref cleanupError, LastError("CloseHandle(process)"));
            }
            if (cleanupError != null) throw cleanupError;
        }
    }
}
'@

try {
  Add-Type -TypeDefinition $source
  $applicationName = $env:JUMPGATE_SUPERVISED_APPLICATION
  $commandLine = $env:JUMPGATE_SUPERVISED_COMMAND_LINE
  Remove-Item Env:JUMPGATE_SUPERVISED_APPLICATION -ErrorAction SilentlyContinue
  Remove-Item Env:JUMPGATE_SUPERVISED_COMMAND_LINE -ErrorAction SilentlyContinue
  $status = [JumpgateProcessSupervisor]::Run(
    $applicationName,
    $commandLine,
    [Environment]::CurrentDirectory)
  [Environment]::Exit($status)
} catch {
  [Console]::Error.WriteLine("Jumpgate Windows process supervisor failed.")
  [Environment]::Exit(72)
}
`;
const PROBE_ID = "d".repeat(32);
const HARNESS_LOG_SCHEMA = "jumpgate-s3-harness-v2";
const PRIVACY_VERSION_ID = "jumpgate-ci-privacy-1";

function acceptedHarnessOperation(sequenceId, operation, context = {}, isPublic) {
  const record = {
    schema: HARNESS_LOG_SCHEMA,
    event: "operation",
    probeId: PROBE_ID,
    sequenceId,
    authenticated: true,
    operation,
    outcome: "accepted",
    scopeId: context.scopeId ?? null,
    objectId: context.objectId ?? null,
    versionSelector: context.versionSelector ?? "none",
    requestedVersionId: context.requestedVersionId ?? null,
    versionId: context.versionId ?? null,
    objectCount: context.objectCount ?? null,
  };
  if (isPublic !== undefined) record.isPublic = isPublic;
  return JSON.stringify(record);
}

function rejectedHarnessRequest(sequenceId, operation, reason, context) {
  return JSON.stringify({
    schema: HARNESS_LOG_SCHEMA,
    event: "request",
    probeId: PROBE_ID,
    sequenceId,
    authenticated: true,
    operation,
    outcome: "rejected",
    reason,
    scopeId: context.scopeId ?? null,
    objectId: context.objectId,
    versionSelector: context.versionSelector ?? "none",
    requestedVersionId: context.requestedVersionId ?? null,
    versionId: context.versionId ?? null,
  });
}

function privacyPrefix(sequenceId, isPublic) {
  return [
    acceptedHarnessOperation(sequenceId, "HeadBucket"),
    acceptedHarnessOperation(sequenceId, "GetBucketAcl"),
    acceptedHarnessOperation(sequenceId, "GetBucketPolicyStatus", {}, isPublic),
  ];
}

function erasureProof(sequenceId, ordinal) {
  const rawScope = `fixture-erasure-scope-${ordinal}`;
  const rawObject = `${rawScope}/fixture-erasure-object-${ordinal}`;
  const object = {
    scopeId: deriveResourceId(PROBE_ID, "erasure-scope", rawScope),
    objectId: deriveResourceId(PROBE_ID, "erasure-object", rawObject),
    versionId: `jumpgate-ci-erasure-${ordinal}`,
  };
  const empty = { scopeId: object.scopeId, objectCount: 0 };
  return [
    acceptedHarnessOperation(sequenceId, "ListObjectVersions", empty),
    acceptedHarnessOperation(sequenceId, "ListObjectVersions", empty),
    acceptedHarnessOperation(sequenceId, "PutObject", object),
    acceptedHarnessOperation(sequenceId, "ListObjectVersions", {
      ...object,
      objectCount: 1,
    }),
    acceptedHarnessOperation(sequenceId, "DeleteObject", {
      ...object,
      versionSelector: "exact",
      requestedVersionId: object.versionId,
    }),
    acceptedHarnessOperation(sequenceId, "ListObjectVersions", empty),
    rejectedHarnessRequest(sequenceId, "HeadObject", "state/missing", {
      ...object,
      versionSelector: "exact",
      requestedVersionId: object.versionId,
      versionId: null,
    }),
    acceptedHarnessOperation(sequenceId, "ListObjectVersions", empty),
    rejectedHarnessRequest(sequenceId, "HeadObject", "state/missing", {
      ...object,
      versionSelector: "exact",
      requestedVersionId: object.versionId,
      versionId: null,
    }),
  ];
}

function privateHarnessProof() {
  const lines = [];
  const privacy = {
    objectId: deriveObjectId(PROBE_ID, "privacy"),
    versionId: PRIVACY_VERSION_ID,
  };
  for (let ordinal = 1; ordinal <= 4; ordinal += 1) {
    const sequenceId = deriveSequenceId(PROBE_ID, ordinal);
    lines.push(...privacyPrefix(sequenceId, false));
    if (ordinal === 1) {
      lines.push(acceptedHarnessOperation(sequenceId, "PutObject", privacy));
    } else {
      lines.push(
        rejectedHarnessRequest(sequenceId, "PutObject", "state/replay", {
          ...privacy,
          versionId: null,
        })
      );
      lines.push(acceptedHarnessOperation(sequenceId, "HeadObject", privacy));
      lines.push(acceptedHarnessOperation(sequenceId, "HeadObject", privacy));
    }
    for (const operation of ["HeadObject", "GetObject", "GetObjectAcl"]) {
      lines.push(
        acceptedHarnessOperation(sequenceId, operation, {
          ...privacy,
          versionSelector: "exact",
          requestedVersionId: privacy.versionId,
        })
      );
    }
    if (ordinal <= 3) lines.push(...erasureProof(sequenceId, ordinal));
  }
  return Object.freeze(lines);
}

const PRIVATE_HARNESS_PROOF = privateHarnessProof();
const PUBLIC_HARNESS_PROOF = Object.freeze(
  privacyPrefix(deriveSequenceId(PROBE_ID, 1), true)
);
const HELPER_SHA256 = "c951a1d7a064b00d33c81657de6c7bf7ff624271c6866fb400b0a399cbcfacc6";
const DOCKER_RESOLUTION_BLOCK =
  [
    "unset DOCKER_HOST DOCKER_CONTEXT DOCKER_CONFIG DOCKER_API_VERSION \\",
    "  DOCKER_CERT_PATH DOCKER_TLS_VERIFY",
    'DOCKER_BIN="${JUMPGATE_DOCKER_BIN:-}"',
    'if [[ -z "$DOCKER_BIN" ]]; then',
    '  if ! DOCKER_BIN="$(command -v docker)"; then',
    '    echo "Container smoke topology failed: Docker executable is unavailable." >&2',
    "    exit 1",
    "  fi",
    "fi",
    'if [[ "$DOCKER_BIN" != /* || ! -f "$DOCKER_BIN" || ! -x "$DOCKER_BIN" ]]; then',
    '  echo "Container smoke topology failed: Docker executable is invalid." >&2',
    "  exit 1",
    "fi",
    "readonly DOCKER_BIN",
    "docker_cli() {",
    '  "$DOCKER_BIN" "$@"',
    "}",
    "readonly -f docker_cli",
    "unset JUMPGATE_DOCKER_BIN",
  ].join("\n") + "\n";

const RECORD_LOCK_IMPLEMENTATION = String.raw`
record_lock_fail() {
  printf 'Topology recorder lock failed.\n' >&2
  return 70
}

record_lock_read_owner() {
  local lock="$1"
  local owner_pid=""
  local owner_token=""
  local extra=""
  IFS=' ' read -r owner_pid owner_token extra 2>/dev/null <"$lock/owner" || return 1
  [[ "$owner_pid" =~ ^[1-9][0-9]*$ ]] || return 1
  [[ "$owner_token" =~ ^[A-Za-z0-9._-]+$ && -z "$extra" ]] || return 1
  printf '%s %s\n' "$owner_pid" "$owner_token"
}

record_lock_remove_owned_directory() {
  local lock="$1"
  local expected_pid="$2"
  local expected_token="$3"
  local attempt=0
  local current=""
  local owner_removed=0
  for ((attempt = 0; attempt < RECORD_LOCK_RELEASE_ATTEMPTS; attempt += 1)); do
    if [[ ! -e "$lock" ]]; then
      return 0
    fi
    if [[ "$owner_removed" -eq 0 ]]; then
      current="$(record_lock_read_owner "$lock")" || current=""
      if [[ "$current" != "$expected_pid $expected_token" ]]; then
        sleep "$RECORD_LOCK_RETRY_DELAY"
        continue
      fi
      if ! rm -f -- "$lock/owner" 2>/dev/null; then
        sleep "$RECORD_LOCK_RETRY_DELAY"
        continue
      fi
      owner_removed=1
    fi
    if rmdir -- "$lock" 2>/dev/null; then
      return 0
    fi
    sleep "$RECORD_LOCK_RETRY_DELAY"
  done
  record_lock_fail
}

record_lock_recovery_finalize() {
  local status=$?
  trap - EXIT HUP INT TERM
  if ! record_lock_remove_owned_directory \
    "$RECORD_LOCK_RECOVERY_PATH" \
    "$RECORD_LOCK_RECOVERY_PID" \
    "$RECORD_LOCK_RECOVERY_TOKEN"; then
    status=70
  fi
  exit "$status"
}

record_lock_recover_stale() (
  local lock="$1"
  local contender="$2"
  local recovery="$lock.recovery"
  local owner=""
  local owner_pid=""
  local owner_token=""
  local recovery_pid="${PARAMETER}BASHPID:-$$}"
  if ! mkdir -- "$recovery" 2>/dev/null; then
    exit 1
  fi
  if ! printf '%s %s\n' "$recovery_pid" "$contender" >"$recovery/owner"; then
    rm -f -- "$recovery/owner" 2>/dev/null || true
    rmdir -- "$recovery" 2>/dev/null || true
    record_lock_fail
    exit 70
  fi
  RECORD_LOCK_RECOVERY_PATH="$recovery"
  RECORD_LOCK_RECOVERY_PID="$recovery_pid"
  RECORD_LOCK_RECOVERY_TOKEN="$contender"
  trap record_lock_recovery_finalize EXIT
  trap 'exit 70' HUP INT TERM
  owner="$(record_lock_read_owner "$lock")" || exit 1
  owner_pid="${PARAMETER}owner%% *}"
  owner_token="${PARAMETER}owner#* }"
  if kill -0 "$owner_pid" 2>/dev/null; then
    exit 1
  fi
  record_lock_remove_owned_directory "$lock" "$owner_pid" "$owner_token"
)

record_lock_acquire() {
  local lock="$1"
  local attempt=0
  local owner_pid="${PARAMETER}BASHPID:-$$}"
  local owner_token="$owner_pid-$RANDOM-$RANDOM"
  for ((attempt = 0; attempt < RECORD_LOCK_ACQUIRE_ATTEMPTS; attempt += 1)); do
    if [[ ! -e "$lock.recovery" ]] && mkdir -- "$lock" 2>/dev/null; then
      if ! printf '%s %s\n' "$owner_pid" "$owner_token" >"$lock/owner"; then
        rmdir -- "$lock" 2>/dev/null || true
        record_lock_fail
        return 70
      fi
      RECORD_LOCK_PATH="$lock"
      RECORD_LOCK_OWNER_PID="$owner_pid"
      RECORD_LOCK_OWNER_TOKEN="$owner_token"
      return 0
    fi
    if record_lock_recover_stale "$lock" "$owner_token"; then
      continue
    elif [[ "$?" -eq 70 ]]; then
      return 70
    fi
    sleep "$RECORD_LOCK_RETRY_DELAY"
  done
  record_lock_fail
}

record_lock_release() {
  local attempt=0
  local kind=""
  case "$RECORD_LOCK_PATH" in
    */record.lock) kind="record" ;;
    */event.lock) kind="event" ;;
  esac
  if [[ "${PARAMETER}RECORD_LOCK_FAIL_RELEASE:-}" != "all" &&
    "${PARAMETER}RECORD_LOCK_FAIL_RELEASE:-}" != "$kind" ]]; then
    record_lock_remove_owned_directory \
      "$RECORD_LOCK_PATH" "$RECORD_LOCK_OWNER_PID" "$RECORD_LOCK_OWNER_TOKEN"
    return
  fi
  for ((attempt = 0; attempt < RECORD_LOCK_RELEASE_ATTEMPTS; attempt += 1)); do
    sleep "$RECORD_LOCK_RETRY_DELAY"
  done
  record_lock_fail
}

record_lock_finalize() {
  local status=$?
  trap - EXIT HUP INT TERM
  if ! record_lock_release; then
    status=70
  fi
  exit "$status"
}

record_append() (
  local lock="$1"
  local record="$2"
  local hold="${PARAMETER}RECORD_LOCK_HOLD_SECONDS:-0}"
  shift 2
  RECORD_LOCK_PATH=""
  RECORD_LOCK_OWNER_PID=""
  RECORD_LOCK_OWNER_TOKEN=""
  RECORD_LOCK_ACQUIRE_ATTEMPTS="${PARAMETER}RECORD_LOCK_ACQUIRE_ATTEMPTS:-200}"
  RECORD_LOCK_RELEASE_ATTEMPTS="${PARAMETER}RECORD_LOCK_RELEASE_ATTEMPTS:-20}"
  RECORD_LOCK_RETRY_DELAY="${PARAMETER}RECORD_LOCK_RETRY_DELAY:-0.005}"
  [[ "$RECORD_LOCK_ACQUIRE_ATTEMPTS" =~ ^[1-9][0-9]*$ ]] || exit 70
  [[ "$RECORD_LOCK_RELEASE_ATTEMPTS" =~ ^[1-9][0-9]*$ ]] || exit 70
  [[ "$RECORD_LOCK_RETRY_DELAY" =~ ^0\.[0-9]+$ ]] || exit 70
  [[ "$hold" =~ ^[0-9]+([.][0-9]+)?$ ]] || exit 70
  record_lock_acquire "$lock"
  trap record_lock_finalize EXIT
  trap 'exit 70' HUP INT TERM
  if [[ "$hold" != "0" ]]; then
    sleep "$hold"
  fi
  {
    printf '%s\0' "$#"
    printf '%s\0' "$@"
  } >>"$record"
)
`;

const DOCKER_SHIM =
  String.raw`#!/usr/bin/env bash
set -euo pipefail
` +
  RECORD_LOCK_IMPLEMENTATION +
  String.raw`
record_append "$DOCKER_SHIM_STATE/record.lock" "$DOCKER_SHIM_RECORD" "$@"
record_append "$DOCKER_SHIM_STATE/event.lock" "$DOCKER_SHIM_EVENT_RECORD" docker "$@"

if [[ "${PARAMETER}DOCKER_SHIM_HANG:-}" == "1" ]]; then
  "$DOCKER_SHIM_NODE" -e \
    ${JSON.stringify(HANG_PROCESS_TREE_SCRIPT)}
fi

command="$1"
shift
case "$command" in
  pull)
    exit 0
    ;;
  network)
    subcommand="$1"
    shift
    case "$subcommand" in
      create)
        touch "$DOCKER_SHIM_STATE/network"
        printf 'network-id\n'
        ;;
      rm)
        if [[ -n "${PARAMETER}DOCKER_SHIM_NETWORK_RM_STATUS:-}" ]]; then
          exit "$DOCKER_SHIM_NETWORK_RM_STATUS"
        fi
        rm -f "$DOCKER_SHIM_STATE/network"
        ;;
      inspect)
        test -f "$DOCKER_SHIM_STATE/network"
        ;;
      connect)
        exit 0
        ;;
    esac
    ;;
  run)
    name=""
    remove=false
    previous=""
    for argument in "$@"; do
      [[ "$argument" == "--rm" ]] && remove=true
      if [[ "$previous" == "--name" ]]; then
        name="$argument"
        break
      fi
      previous="$argument"
    done
    test -n "$name"
    touch "$DOCKER_SHIM_STATE/containers/$name"
    if [[ "${PARAMETER}TOPOLOGY_FAIL_PHASE:-}" == "docker:run:$name" ]]; then
      [[ "$remove" == "false" ]] || rm -f "$DOCKER_SHIM_STATE/containers/$name"
      exit "${PARAMETER}TOPOLOGY_FAIL_STATUS:-23}"
    fi
    case "$name" in
      jumpgate-http-smoke-ci)
        printf 'HTTP smoke passed: live, ready, version, manifest, configure.\n'
        [[ -z "${PARAMETER}DOCKER_SHIM_EXTRA_STDOUT:-}" ]] ||
          printf '%s\n' "$DOCKER_SHIM_EXTRA_STDOUT"
        [[ -z "${PARAMETER}DOCKER_SHIM_EXTRA_STDERR:-}" ]] ||
          printf '%s\n' "$DOCKER_SHIM_EXTRA_STDERR" >&2
        if [[ "${PARAMETER}DOCKER_SHIM_SECRET_FRAGMENT:-}" == "1" ]]; then
          fragment="$(sed -n '1p' "$DOCKER_SHIM_SECRET_CAPTURE")"
          printf '%.8s\n' "$fragment"
        fi
        exit "$DOCKER_SHIM_POSITIVE_SMOKE_STATUS"
        ;;
      jumpgate-http-smoke-ci-public)
        if [[ -n "${PARAMETER}DOCKER_SHIM_PUBLIC_SMOKE_DELAY_SECONDS:-}" ]]; then
          sleep "$DOCKER_SHIM_PUBLIC_SMOKE_DELAY_SECONDS"
        fi
        printf 'HTTP smoke passed: live and negative readiness attestation.\n'
        exit "$DOCKER_SHIM_PUBLIC_SMOKE_STATUS"
        ;;
    esac
    printf 'container-%s\n' "$name"
    [[ "$remove" == "false" ]] || rm -f "$DOCKER_SHIM_STATE/containers/$name"
    ;;
  inspect)
    format=""
    target=""
    while [[ "$#" -gt 0 ]]; do
      if [[ "$1" == "--format" ]]; then
        format="$2"
        shift 2
      else
        target="$1"
        shift
      fi
    done
    test -f "$DOCKER_SHIM_STATE/containers/$target"
    case "$format" in
      '{{.State.Health.Status}}') printf 'healthy\n' ;;
      '{{.State.Running}}') printf 'true\n' ;;
      '{{.Image}}')
        if [[ "${PARAMETER}TOPOLOGY_BAD_IMAGE_CONTAINER:-}" == "$target" ]]; then
          printf 'sha256:wrong-image\n'
        else
          printf 'sha256:release-image\n'
        fi
        ;;
    esac
    ;;
  image)
    test "$1" = "inspect"
    printf 'sha256:release-image\n'
    ;;
  container)
    test "$1" = "inspect"
    test -f "$DOCKER_SHIM_STATE/containers/$2"
    ;;
  logs)
    target="$1"
    probe_id="$(sed -n 's/^S3_HARNESS_PROBE_ID=//p' "$DOCKER_SHIM_HARNESS_ENV")"
    case "$target" in
      jumpgate-s3-ci)
        count_file="$DOCKER_SHIM_STATE/private-log-count"
        count=0
        [[ -f "$count_file" ]] && count="$(cat "$count_file")"
        count=$((count + 1))
        printf '%s\n' "$count" >"$count_file"
        printf '{"schema":"jumpgate-s3-harness-v2","event":"ready","probeId":"%s","mode":"private"}\n' "$probe_id"
        if [[ "$count" -gt 1 ]]; then
          cat "$DOCKER_SHIM_PRIVATE_HARNESS_PROOF_FILE"
        fi
        ;;
      jumpgate-s3-ci-public)
        count_file="$DOCKER_SHIM_STATE/public-log-count"
        count=0
        [[ -f "$count_file" ]] && count="$(cat "$count_file")"
        count=$((count + 1))
        printf '%s\n' "$count" >"$count_file"
        printf '{"schema":"jumpgate-s3-harness-v2","event":"ready","probeId":"%s","mode":"public"}\n' "$probe_id"
        if [[ "$count" -gt 1 ]]; then
          if [[ "$count" -eq 2 ]]; then
          for attempt in {1..200}; do
            [[ -f "$DOCKER_SHIM_STATE/containers/jumpgate-http-smoke-ci-public" ]] && break
            sleep 0.01
          done
          fi
          cat "$DOCKER_SHIM_PUBLIC_HARNESS_PROOF_FILE"
        fi
        ;;
      *)
        printf 'redaction-safe application log\n'
        ;;
    esac
    if [[ "${PARAMETER}TOPOLOGY_FAIL_PHASE:-}" == "docker:logs:$target" ]]; then
      exit "${PARAMETER}TOPOLOGY_FAIL_STATUS:-23}"
    fi
    ;;
  rm)
    force=false
    for target in "$@"; do
      [[ "$target" == "--force" ]] && force=true
    done
    if [[ "$force" == "true" && -n "${PARAMETER}DOCKER_SHIM_FORCE_RM_STATUS:-}" ]]; then
      exit "$DOCKER_SHIM_FORCE_RM_STATUS"
    fi
    for target in "$@"; do
      [[ "$target" == --* ]] && continue
      rm -f "$DOCKER_SHIM_STATE/containers/$target"
    done
    ;;
  stop)
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`;

const NODE_SHIM =
  String.raw`#!/usr/bin/env bash
set -euo pipefail
` +
  RECORD_LOCK_IMPLEMENTATION +
  String.raw`
if [[ "$1" != */scripts/ci/container-smoke-env.js ]]; then
  exec "$DOCKER_SHIM_NODE" "$@"
fi

command="${PARAMETER}2:-}"
label=""
secret_values=""
for argument in "$@"; do
  case "$argument" in
    --input=*)
      input="${PARAMETER}argument#--input=}"
      label="${PARAMETER}input##*/}"
      label="${PARAMETER}label%.raw.log}"
      label="${PARAMETER}label%.log}"
      ;;
    --secret-values=*) secret_values="${PARAMETER}argument#--secret-values=}" ;;
  esac
done

record_append "$DOCKER_SHIM_STATE/event.lock" "$DOCKER_SHIM_EVENT_RECORD" \
  node "$command" "$label" begin
if [[ "${PARAMETER}NODE_SHIM_HANG:-}" == "1" ]]; then
  "$DOCKER_SHIM_NODE" -e \
    ${JSON.stringify(HANG_PROCESS_TREE_SCRIPT)}
fi
set +e
"$DOCKER_SHIM_NODE" "$@"
status=$?
set -e
if [[ "$status" -eq 0 && "$command" == "generate" ]]; then
  test -n "$secret_values"
  cp "$secret_values" "$DOCKER_SHIM_SECRET_CAPTURE"
  sed -i "s/^S3_HARNESS_PROBE_ID=.*/S3_HARNESS_PROBE_ID=$DOCKER_SHIM_PROBE_ID/" \
    "$DOCKER_SHIM_HARNESS_ENV"
fi
if [[ "${PARAMETER}TOPOLOGY_FAIL_PHASE:-}" == "node:$command:$label" ]]; then
  status="${PARAMETER}TOPOLOGY_FAIL_STATUS:-23}"
fi
record_append "$DOCKER_SHIM_STATE/event.lock" "$DOCKER_SHIM_EVENT_RECORD" \
  node "$command" "$label" end "$status"
exit "$status"
`;

function shellPath(filename) {
  if (process.platform !== "win32") return filename;
  const normalized = path.resolve(filename).replace(/\\/g, "/");
  return normalized.replace(/^([A-Za-z]):/, (_match, drive) => `/${drive.toLowerCase()}`);
}

function bashPath() {
  if (process.env.JUMPGATE_TEST_BASH) return process.env.JUMPGATE_TEST_BASH;
  if (process.platform !== "win32") return "bash";
  return path.join(process.env.ProgramFiles || "C:/Program Files", "Git/bin/bash.exe");
}

function replaceOnce(source, needle, replacement) {
  const index = source.indexOf(needle);
  assert.notEqual(index, -1, `mutation marker missing: ${needle}`);
  return source.slice(0, index) + replacement + source.slice(index + needle.length);
}

function validateHelperContract(source) {
  const syntax = spawnSync(bashPath(), ["-n"], {
    cwd: ROOT,
    encoding: "utf8",
    input: source,
  });
  assert.equal(syntax.status, 0, syntax.stderr || "helper syntax validation failed");

  const contractIndex = source.indexOf(DOCKER_RESOLUTION_BLOCK);
  assert.notEqual(contractIndex, -1, "approved Docker resolver contract is required");
  assert.equal(
    source.indexOf(DOCKER_RESOLUTION_BLOCK, contractIndex + DOCKER_RESOLUTION_BLOCK.length),
    -1,
    "Docker resolver contract must be unique"
  );
  const outsideContract =
    source.slice(0, contractIndex) +
    source.slice(contractIndex + DOCKER_RESOLUTION_BLOCK.length);
  const forbiddenEscapes = [
    [/\bcommand\s+-p\s+(?:--\s+)?docker\b/, "command -p Docker resolution"],
    [/(?:^|[\s"'(])\/[^\s"'();]*\/docker\b/m, "absolute Docker executable"],
    [/\bdocker\b/, "literal Docker command outside the wrapper"],
    [
      /\bDOCKER_(?:HOST|API_VERSION|CONTEXT|CONFIG|CERT_PATH|TLS_VERIFY)\b/,
      "Docker transport environment access",
    ],
    [/(?:docker\.sock|\/var\/run\/docker|\/run\/docker)/, "direct Docker socket access"],
    [/\b(?:eval|exec|curl|wget|socat|nc|ncat|xargs)\b/, "external command escape"],
    [/\b(?:bash|sh)\s+-c\b/, "nested shell escape"],
  ];
  for (const [pattern, label] of forbiddenEscapes) {
    assert.doesNotMatch(outsideContract, pattern, label);
  }
  assert.equal(
    (outsideContract.match(/\bdocker_cli\b/g) || []).length,
    35,
    "every Docker operation must use the one readonly wrapper"
  );

  // This detects accidental helper drift. A malicious change that also rewrites
  // this test contract is intentionally outside the regression test threat model.
  assert.equal(
    createHash("sha256").update(source).digest("hex"),
    HELPER_SHA256,
    "canonical helper source changed without contract review"
  );
}

function parseWorkflow(source) {
  assertRubyPsych();
  const result = spawnSync("ruby", [WORKFLOW_PARSER], {
    cwd: ROOT,
    encoding: "utf8",
    input: source,
  });
  if (result.status !== 0) throw new Error(result.stderr || "workflow parser failed");
  return JSON.parse(result.stdout);
}

function expectedJobStep(job, keys, values) {
  return {
    job,
    keys,
    name: null,
    id: null,
    if: null,
    run: null,
    uses: null,
    shell: null,
    workingDirectory: null,
    timeoutMinutes: null,
    continueOnError: null,
    env: null,
    with: null,
    ...values,
  };
}

function expectedStep(keys, values) {
  return expectedJobStep("container-smoke", keys, values);
}

function expectedContainerSmokeSteps() {
  return [
    expectedStep(["name", "uses", "with"], {
      name: "Check out Bridge",
      uses: "actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5",
      with: { "persist-credentials": "false" },
    }),
    expectedStep(["name", "uses", "with"], {
      name: "Set up Node.js",
      uses: "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
      with: { "node-version": "${{ env.NODE_VERSION }}" },
    }),
    expectedStep(["name", "run"], {
      name: "Build the only release image",
      run: BUILD_RUN,
    }),
    expectedStep(["name", "run"], {
      name: STEP_NAME,
      run: HELPER_INVOCATION,
    }),
    expectedStep(["name", "id", "if", "run"], {
      name: "Export integrity-bound release image",
      id: "export-image",
      if: RELEASE_IF,
      run: EXPORT_RUN,
    }),
    expectedStep(["name", "if", "uses", "with"], {
      name: "Preserve exact image for deployment",
      if: RELEASE_IF,
      uses: "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
      with: {
        name: "jumpgate-image-${{ github.sha }}",
        path:
          "${{ runner.temp }}/jumpgate-image/jumpgate-image.tar\n" +
          "${{ runner.temp }}/jumpgate-image/jumpgate-image.tar.sha256\n",
        "if-no-files-found": "error",
        "retention-days": "35",
        "compression-level": "0",
      },
    }),
  ];
}

function expectedFingerprintParitySteps() {
  return [
    expectedJobStep("fingerprint-parity", ["name", "uses", "with"], {
      name: "Check out Bridge",
      uses: "actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5",
      with: { "persist-credentials": "false" },
    }),
    expectedJobStep("fingerprint-parity", ["name", "run"], {
      name: "Validate pinned Kodi source",
      run: KODI_PIN_VALIDATION_RUN,
    }),
    expectedJobStep("fingerprint-parity", ["name", "uses", "with"], {
      name: "Check out exact Kodi commit",
      uses: "actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5",
      with: {
        repository: "${{ env.KODI_REPOSITORY }}",
        ref: "${{ env.KODI_SHA }}",
        path: ".ci/kodi",
        "fetch-depth": "1",
        "persist-credentials": "false",
      },
    }),
    expectedJobStep("fingerprint-parity", ["name", "uses", "with"], {
      name: "Set up Node.js",
      uses: "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
      with: { "node-version": "${{ env.NODE_VERSION }}", cache: "npm" },
    }),
    expectedJobStep("fingerprint-parity", ["name", "run"], {
      name: "Install locked dependencies",
      run: "npm ci",
    }),
    expectedJobStep("fingerprint-parity", ["name", "env", "run"], {
      name: "Verify exact checkout and fixture parity without skips",
      env: {
        JUMPGATE_KODI_FINGERPRINT_FIXTURE:
          "${{ github.workspace }}/.ci/kodi/xbmc/utils/test/fixtures/source-fingerprint-v1.json",
      },
      run: FINGERPRINT_PARITY_RUN,
    }),
  ];
}

function validateWorkflow(source) {
  const model = parseWorkflow(source);
  assert.deepEqual(model.globalEnv, WORKFLOW_ENV, "global inherited environment must be exact");
  assert.deepEqual(model.globalDefaults, {
    keys: ["run"],
    runKeys: ["shell"],
    shell: "bash",
    workingDirectory: null,
  });

  const job = model.jobs["container-smoke"];
  assert.ok(job, "container-smoke job is required");
  assert.deepEqual(job.keys, ["name", "runs-on", "timeout-minutes", "outputs", "steps"]);
  assert.equal(job.name, "Immutable production image / PostgreSQL + Redis + private S3");
  assert.equal(job.runsOn, "ubuntu-latest");
  assert.equal(job.timeoutMinutes, "25");
  assert.equal(job.env, null);
  assert.equal(job.hasContainer, false);
  assert.equal(job.defaults, null);
  assert.deepEqual(job.outputs, {
    "archive-sha256": "${{ steps.export-image.outputs.archive-sha256 }}",
  });
  assert.deepEqual(job.steps, expectedContainerSmokeSteps());

  const redisJob = model.jobs["redis-live"];
  assert.ok(redisJob, "redis-live job is required");
  assert.deepEqual(redisJob.keys, [
    "name", "runs-on", "timeout-minutes", "strategy", "services", "env", "steps",
  ]);
  assert.equal(redisJob.name, "Redis ${{ matrix.redis_major }} / 48 live contracts");
  assert.deepEqual(redisJob.strategy, {
    "fail-fast": "false",
    matrix: {
      include: [
        { redis_major: "7", redis_image: REDIS_7_IMAGE },
        { redis_major: "8", redis_image: REDIS_8_IMAGE },
      ],
    },
  });
  assert.equal(redisJob.services.redis.image, "${{ matrix.redis_image }}");
  assert.deepEqual(redisJob.services.redis.ports, ["6379:6379"]);
  assert.match(redisJob.services.redis.options, /--health-cmd "redis-cli ping"/);

  const postgresJob = model.jobs["postgres-live"];
  assert.ok(postgresJob, "postgres-live job is required");
  assert.deepEqual(postgresJob.keys, [
    "name", "runs-on", "timeout-minutes", "strategy", "services", "env", "steps",
  ]);
  assert.equal(
    postgresJob.name,
    "PostgreSQL ${{ matrix.postgres_major }} / 22 live storage contracts"
  );
  assert.deepEqual(postgresJob.strategy, {
    "fail-fast": "false",
    matrix: {
      include: [
        { postgres_major: "16", postgres_image: POSTGRES_16_IMAGE },
        { postgres_major: "17", postgres_image: POSTGRES_17_IMAGE },
      ],
    },
  });
  assert.equal(postgresJob.services.postgres.image, "${{ matrix.postgres_image }}");
  assert.equal(postgresJob.services.redis.image, REDIS_8_IMAGE);
  assert.deepEqual(postgresJob.env, {
    JUMPGATE_POSTGRES_LIVE_AGGREGATE: "1",
    TEST_POSTGRES_URL:
      "postgresql://jumpgate:jumpgate_ci_password@127.0.0.1:5432/jumpgate_ci",
    REDIS_URL: "redis://127.0.0.1:6379/0",
  });
  const postgresRun = postgresJob.steps.find(
    (step) => step.name === "Run every live PostgreSQL and cross-store contract without skips"
  );
  assert.ok(postgresRun, "complete PostgreSQL live gate is required");
  assert.match(postgresRun.run, /--expected-tests=22/);
  assert.match(postgresRun.run, /test\/storage-history-grant-migrations\.test\.js/);
  assert.match(postgresRun.run, /test\/storage-history-grant-parity\.test\.js/);

  const steps = Object.values(model.jobs).flatMap((candidate) => candidate.steps);
  const parityJob = model.jobs["fingerprint-parity"];
  assert.ok(parityJob, "fingerprint-parity job is required");
  assert.deepEqual(parityJob.keys, ["name", "runs-on", "timeout-minutes", "steps"]);
  assert.equal(parityJob.name, "Bridge / Kodi fingerprint parity");
  assert.equal(parityJob.runsOn, "ubuntu-latest");
  assert.equal(parityJob.timeoutMinutes, "10");
  assert.equal(parityJob.env, null);
  assert.equal(parityJob.hasContainer, false);
  assert.equal(parityJob.defaults, null);
  assert.equal(parityJob.outputs, null);
  assert.deepEqual(parityJob.steps, expectedFingerprintParitySteps());
  const parityInvocationCount = steps.reduce(
    (count, step) => count + ((step.run || "").split(VERSION_PARITY_INVOCATION).length - 1),
    0
  );
  assert.equal(parityInvocationCount, 1, "Kodi version parity invocation must be unique");
  const deployJob = model.jobs.deploy;
  assert.ok(deployJob, "deploy job is required");
  assert.deepEqual(deployJob.keys, [
    "name",
    "needs",
    "if",
    "runs-on",
    "timeout-minutes",
    "environment",
    "concurrency",
    "steps",
  ]);
  assert.deepEqual(deployJob.needs, [
    "quality",
    "redis-live",
    "postgres-live",
    "fingerprint-parity",
    "container-smoke",
  ]);
  assert.equal(deployJob.if, DEPLOY_IF);
  assert.deepEqual(deployJob.environment, {
    name: "production",
    url: "https://jumpgate-bridge.fly.dev/configure",
  });
  assert.deepEqual(deployJob.concurrency, {
    group: "fly-production",
    "cancel-in-progress": "false",
  });
  const flyctlVerificationSteps = deployJob.steps.filter(
    (step) => step.name === "Install and verify pinned Fly CLI before authentication"
  );
  assert.deepEqual(flyctlVerificationSteps, [
    expectedJobStep("deploy", ["name", "run"], {
      name: "Install and verify pinned Fly CLI before authentication",
      run: FLYCTL_VERIFY_RUN,
    }),
  ]);
  const named = steps.filter((step) => step.name === STEP_NAME);
  const invocations = steps.filter((step) =>
    (step.run || "").includes("scripts/ci/container-smoke-topology.sh")
  );
  assert.equal(named.length, 1, "target workflow step must be unique");
  assert.equal(invocations.length, 1, "topology helper invocation must be unique");
  assert.equal(named[0], invocations[0], "the named target must own the only invocation");

  const helperIndex = job.steps.indexOf(named[0]);
  assert.equal(helperIndex, 3);
  const forbiddenSetupMutation =
    /GITHUB_(?:ENV|PATH)|DOCKER_[A-Z_]+|JUMPGATE_DOCKER_BIN|NODE_OPTIONS|BASH_ENV|SHELLOPTS|(?:^|[\/])\.(?:bashrc|bash_profile)|\/etc\/profile/;
  for (const step of job.steps.slice(0, helperIndex)) {
    assert.doesNotMatch(step.run || "", forbiddenSetupMutation);
  }
  assert.equal(job.steps[helperIndex + 1].if, RELEASE_IF);
  return model;
}

function readDockerRecord(filename) {
  if (!fs.existsSync(filename)) return [];
  const fields = fs.readFileSync(filename).toString("utf8").split("\0");
  fields.pop();
  const records = [];
  for (let index = 0; index < fields.length; ) {
    const count = Number(fields[index]);
    assert.equal(Number.isSafeInteger(count) && count > 0, true, "invalid Docker record");
    index += 1;
    assert.equal(index + count <= fields.length, true, "truncated Docker record");
    records.push(fields.slice(index, index + count));
    index += count;
  }
  return records;
}

function isTerminationPid(candidate) {
  return Number.isSafeInteger(candidate) && candidate > 0 && candidate !== process.pid;
}

function cleanupFailure(code, message, cause) {
  const error = Object.assign(new Error(message), { code });
  if (cause) error.cause = cause;
  return error;
}

function readTerminationPids(filenames) {
  const pids = new Set();
  for (const filename of filenames) {
    try {
      const record = JSON.parse(fs.readFileSync(filename, "utf8"));
      const candidates = record.proofPids;
      if (!Array.isArray(candidates)) throw new Error("missing termination identity record");
      if (candidates.length === 0 || candidates.some((candidate) => !isTerminationPid(candidate))) {
        throw new Error("invalid termination identity record");
      }
      for (const candidate of candidates) pids.add(candidate);
    } catch (cause) {
      throw cleanupFailure(
        "ECLEANUPIDENTITY",
        "Process cleanup identity capture failed.",
        cause
      );
    }
  }
  return [...pids];
}

const WINDOWS_PROCESS_SNAPSHOT_SCRIPT = String.raw`
$ErrorActionPreference = "Stop"
$requestedProcessIds = @{}
foreach ($rawProcessId in ($env:JUMPGATE_PROCESS_SNAPSHOT_PIDS -split ',')) {
  [uint32]$requestedProcessId = 0
  if (-not [uint32]::TryParse($rawProcessId, [ref]$requestedProcessId) -or
      $requestedProcessId -eq 0) {
    throw "Invalid process id."
  }
  $requestedProcessIds[$requestedProcessId] = $true
}
Get-CimInstance Win32_Process | ForEach-Object {
  if ($requestedProcessIds.ContainsKey([uint32]$_.ProcessId)) {
    if ($null -eq $_.CreationDate) {
      throw "Missing process creation time."
    }
    "{0}:{1}:{2}" -f $_.ProcessId,
      $_.ParentProcessId,
      $_.CreationDate.ToUniversalTime().Ticks
  }
}
`;
const WINDOWS_PROCESS_SNAPSHOT_ENCODED_COMMAND = Buffer.from(
  WINDOWS_PROCESS_SNAPSHOT_SCRIPT,
  "utf16le"
).toString("base64");

function normalizeSpawnSyncTimeout(timeoutMs, maximumMs = MAX_UINT32) {
  const boundedMaximum = Math.max(
    1,
    Math.min(MAX_UINT32, Number.isFinite(maximumMs) ? Math.floor(maximumMs) : MAX_UINT32)
  );
  const roundedTimeout = Number.isFinite(timeoutMs) ? Math.ceil(timeoutMs) : boundedMaximum;
  return Math.max(1, Math.min(boundedMaximum, roundedTimeout));
}

function snapshotWindowsProcessIdentities(
  pids,
  timeoutMs = WINDOWS_PROCESS_SNAPSHOT_TIMEOUT_MS,
  spawnSyncImplementation = spawnSync
) {
  const requestedPids = [...new Set(pids)].filter(isTerminationPid);
  if (requestedPids.length === 0) return new Map();
  let result;
  try {
    result = spawnSyncImplementation(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        WINDOWS_PROCESS_SNAPSHOT_ENCODED_COMMAND,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          JUMPGATE_PROCESS_SNAPSHOT_PIDS: requestedPids.join(","),
        },
        maxBuffer: 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
        timeout: normalizeSpawnSyncTimeout(timeoutMs, WINDOWS_PROCESS_SNAPSHOT_TIMEOUT_MS),
        windowsHide: true,
      }
    );
  } catch (cause) {
    throw cleanupFailure("ECLEANUPSNAPSHOT", "Windows process snapshot failed.", cause);
  }
  if (result.error || result.signal || result.status !== 0) {
    throw cleanupFailure(
      "ECLEANUPSNAPSHOT",
      "Windows process snapshot failed.",
      result.error
    );
  }

  const requested = new Set(requestedPids);
  const identities = new Map();
  for (const rawLine of result.stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = /^(\d+):(\d+):(\d+)$/.exec(line);
    if (!match) {
      throw cleanupFailure("ECLEANUPIDENTITY", "Invalid Windows process identity.");
    }
    const pid = Number(match[1]);
    const parentPid = Number(match[2]);
    const creationTime = match[3];
    if (
      !requested.has(pid) ||
      !Number.isSafeInteger(parentPid) ||
      parentPid < 0 ||
      identities.has(pid)
    ) {
      throw cleanupFailure("ECLEANUPIDENTITY", "Invalid Windows process identity.");
    }
    identities.set(pid, { creationTime, parentPid, pid });
  }
  return identities;
}

function normalizeWindowsProcessSnapshot(snapshot, pids, timeoutMs) {
  try {
    const identities = snapshot(pids, timeoutMs);
    if (!(identities instanceof Map)) {
      throw cleanupFailure("ECLEANUPIDENTITY", "Invalid Windows process snapshot result.");
    }
    return identities;
  } catch (cause) {
    if (cause?.code === "ECLEANUPIDENTITY" || cause?.code === "ECLEANUPSNAPSHOT") {
      throw cause;
    }
    throw cleanupFailure("ECLEANUPSNAPSHOT", "Windows process snapshot failed.", cause);
  }
}

function matchingWindowsProcessIdentities(expected, observed) {
  const matches = [];
  for (const identity of expected.values()) {
    if (observed.get(identity.pid)?.creationTime === identity.creationTime) {
      matches.push(identity);
    }
  }
  return matches;
}

async function waitForWindowsProcessIdentitiesToExit(expected, snapshot, timeoutMs) {
  const deadline = performance.now() + timeoutMs;
  while (expected.size > 0) {
    const remainingMs = normalizeSpawnSyncTimeout(
      deadline - performance.now(),
      WINDOWS_PROCESS_SNAPSHOT_TIMEOUT_MS
    );
    const observed = normalizeWindowsProcessSnapshot(snapshot, [...expected.keys()], remainingMs);
    const survivors = matchingWindowsProcessIdentities(expected, observed);
    if (survivors.length === 0) return;
    if (performance.now() >= deadline) {
      throw cleanupFailure(
        "ECLEANUPRESIDUAL",
        "Windows process cleanup left a verified descendant alive."
      );
    }
    await new Promise((resolve) => setTimeout(resolve, WINDOWS_PROCESS_VERIFY_RETRY_MS));
  }
}

function quoteWindowsArgument(argument) {
  if (argument.length > 0 && !/[\s"]/.test(argument)) return argument;
  let quoted = '"';
  let backslashes = 0;
  for (const character of argument) {
    if (character === "\\") {
      backslashes += 1;
      continue;
    }
    if (character === '"') {
      quoted += "\\".repeat(backslashes * 2 + 1) + '"';
    } else {
      quoted += "\\".repeat(backslashes) + character;
    }
    backslashes = 0;
  }
  return quoted + "\\".repeat(backslashes * 2) + '"';
}

function spawnDeadlineChild(command, args, spawnOptions) {
  if (process.platform !== "win32") return spawn(command, args, spawnOptions);
  const env = {
    ...(spawnOptions.env || process.env),
    JUMPGATE_JOB_SUPERVISOR_SOURCE: WINDOWS_JOB_SUPERVISOR_SCRIPT,
    JUMPGATE_SUPERVISED_APPLICATION: command,
    JUMPGATE_SUPERVISED_COMMAND_LINE: [command, ...args].map(quoteWindowsArgument).join(" "),
  };
  return spawn(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Invoke-Expression $env:JUMPGATE_JOB_SUPERVISOR_SOURCE",
    ],
    { ...spawnOptions, env }
  );
}

function terminateProcessTree(child, processGroupId = child.pid) {
  if (!child.pid) return false;
  if (process.platform === "win32") {
    // Killing this live supervisor handle closes its job before any shell can unwind cleanup.
    return child.kill("SIGKILL");
  }
  if (!processGroupId) return false;
  try {
    process.kill(-processGroupId, "SIGKILL");
    return true;
  } catch {
    try {
      return child.kill("SIGKILL");
    } catch {
      // The process exited between the deadline check and termination.
      return false;
    }
  }
}

function linuxProcessState(stat, pid) {
  if (typeof stat !== "string") return null;
  const prefix = `${pid} (`;
  if (!stat.startsWith(prefix)) return null;
  const commandEnd = stat.lastIndexOf(")");
  if (
    commandEnd < prefix.length ||
    stat[commandEnd + 1] !== " " ||
    stat[commandEnd + 3] !== " "
  ) {
    return null;
  }
  return stat[commandEnd + 2];
}

function isProcessAlive(
  pid,
  {
    platform = process.platform,
    probeProcess = (candidate, signal) => process.kill(candidate, signal),
    readProcessStat = (candidate) => fs.readFileSync(`/proc/${candidate}/stat`, "utf8"),
  } = {}
) {
  if (!pid) return false;
  if (platform === "linux") {
    try {
      const state = linuxProcessState(readProcessStat(pid), pid);
      if (state === "Z" || state === "X" || state === "x") return false;
      if (state === null) return true;
    } catch {
      // Fall through to the portable existence probe when procfs is unavailable.
    }
  }

  try {
    probeProcess(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function spawnWithTreeDeadline(command, args, options) {
  const {
    deadlineMs,
    deadlineReadyFile,
    deadlineReadyTimeoutMs = deadlineMs,
    maxBuffer,
    processTreeForceFinishMs = PROCESS_TREE_FORCE_FINISH_MS,
    processTreeTerminationRetryMs = PROCESS_TREE_TERMINATION_RETRY_MS,
    spawnDeadlineChildImplementation = spawnDeadlineChild,
    terminateProcessTreeImplementation = terminateProcessTree,
    terminationPidFiles = [],
    windowsProcessSnapshot = snapshotWindowsProcessIdentities,
    ...spawnOptions
  } = options;
  return new Promise((resolve) => {
    const started = performance.now();
    const stdout = [];
    const stderr = [];
    let stdoutLength = 0;
    let stderrLength = 0;
    let error = null;
    let cleanupError = null;
    const cleanupErrors = [];
    let deadlineArmedAt = null;
    let deadlineTimer = null;
    let readyPoll = null;
    let readyTimer = null;
    let retryTimer = null;
    let forcedTimer = null;
    let finishing = false;
    let settled = false;
    let terminationIdentities = new Map();
    const terminationPids = new Set();
    const child = spawnDeadlineChildImplementation(command, args, {
      ...spawnOptions,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const processGroupId = process.platform === "win32" ? null : child.pid;
    const terminateOriginalTree = () =>
      terminateProcessTreeImplementation(child, processGroupId);

    const clearTimers = () => {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      if (readyPoll) clearInterval(readyPoll);
      if (readyTimer) clearTimeout(readyTimer);
      if (retryTimer) clearTimeout(retryTimer);
      if (forcedTimer) clearTimeout(forcedTimer);
    };
    const recordCleanupError = (candidate) => {
      cleanupErrors.push(candidate);
      if (!cleanupError) cleanupError = candidate;
    };
    const releaseChildReferences = () => {
      for (const [name, stream] of [
        ["stdin", child.stdin],
        ["stdout", child.stdout],
        ["stderr", child.stderr],
      ]) {
        if (!stream) continue;
        if (typeof stream.destroy === "function") {
          try {
            stream.destroy();
          } catch (cause) {
            recordCleanupError(
              cleanupFailure("ECLEANUPRELEASE", `Failed to destroy child ${name}.`, cause)
            );
          }
        }
        if (typeof stream.unref === "function") {
          try {
            stream.unref();
          } catch (cause) {
            recordCleanupError(
              cleanupFailure("ECLEANUPRELEASE", `Failed to unref child ${name}.`, cause)
            );
          }
        }
      }
      if (typeof child.unref === "function") {
        try {
          child.unref();
        } catch (cause) {
          recordCleanupError(
            cleanupFailure("ECLEANUPRELEASE", "Failed to unref child process.", cause)
          );
        }
      }
    };
    const settle = (status, signal, closeObserved) => {
      if (settled) return;
      settled = true;
      clearTimers();
      const finished = performance.now();
      resolve({
        cleanupError,
        cleanupErrors: [...cleanupErrors],
        closeObserved,
        error,
        pid: child.pid,
        signal,
        status,
        stderr: Buffer.concat(stderr).toString("utf8"),
        stdout: Buffer.concat(stdout).toString("utf8"),
        deadlineDurationMs: deadlineArmedAt === null ? null : finished - deadlineArmedAt,
        durationMs: finished - started,
        terminationPids: [...terminationPids],
      });
    };
    const finish = async (status, signal, closeObserved = true) => {
      if (settled || finishing) return;
      finishing = true;
      clearTimers();
      if (process.platform === "win32" && error && terminationIdentities.size > 0) {
        try {
          await waitForWindowsProcessIdentitiesToExit(
            terminationIdentities,
            windowsProcessSnapshot,
            PROCESS_TREE_FORCE_FINISH_MS
          );
        } catch (verificationError) {
          recordCleanupError(verificationError);
        }
      }
      settle(status, signal, closeObserved);
    };
    const terminate = (code) => {
      if (error || settled || finishing) return;
      // A leader can exit before descendants release inherited stdio and permit close.
      error = Object.assign(new Error("Topology test process deadline exceeded."), { code });
      try {
        for (const pid of readTerminationPids(terminationPidFiles)) terminationPids.add(pid);
        if (process.platform === "win32") {
          const leaderPids =
            child.exitCode === null && child.signalCode === null ? [child.pid] : [];
          const requestedPids = [...leaderPids, ...terminationPids].filter(isTerminationPid);
          terminationIdentities = normalizeWindowsProcessSnapshot(
            windowsProcessSnapshot,
            requestedPids,
            WINDOWS_PROCESS_SNAPSHOT_TIMEOUT_MS
          );
          if (requestedPids.some((pid) => !terminationIdentities.has(pid))) {
            throw cleanupFailure(
              "ECLEANUPIDENTITY",
              "Windows process identity capture was incomplete."
            );
          }
        }
      } catch (captureError) {
        recordCleanupError(captureError);
      }

      // POSIX keeps the original group ID; Windows targets the supervisor's Job handle.
      try {
        if (
          !terminateOriginalTree() &&
          child.exitCode === null &&
          child.signalCode === null
        ) {
          recordCleanupError(
            cleanupFailure("ECLEANUPTERMINATE", "Process-tree termination failed.")
          );
        }
      } catch (terminationError) {
        recordCleanupError(
          cleanupFailure(
            "ECLEANUPTERMINATE",
            "Process-tree termination failed.",
            terminationError
          )
        );
      }

      if (process.platform === "win32") {
        retryTimer = setTimeout(() => {
          if (settled || finishing) return;
          try {
            terminateOriginalTree();
          } catch (terminationError) {
            recordCleanupError(
              cleanupFailure(
                "ECLEANUPTERMINATE",
                "Process-tree termination failed.",
                terminationError
              )
            );
          }
          if (child.exitCode !== null || child.signalCode !== null) {
            child.stdout.destroy();
            child.stderr.destroy();
          }
        }, processTreeTerminationRetryMs);
      }
      forcedTimer = setTimeout(() => {
        if (settled || finishing) return;
        const terminalCleanupError = cleanupFailure(
          "ECLEANUPTIMEOUT",
          "Process-tree termination did not produce an observed close event."
        );
        cleanupErrors.push(terminalCleanupError);
        cleanupError = terminalCleanupError;
        if (process.platform === "win32") {
          try {
            terminateOriginalTree();
          } catch (terminationError) {
            recordCleanupError(
              cleanupFailure(
                "ECLEANUPTERMINATE",
                "Final process-tree termination failed.",
                terminationError
              )
            );
          }
        }
        releaseChildReferences();
        settle(undefined, undefined, false);
      }, processTreeForceFinishMs);
    };
    const collect = (chunks, chunk, length, code) => {
      const nextLength = length + chunk.length;
      if (nextLength > maxBuffer) {
        terminate(code);
        return length;
      }
      chunks.push(chunk);
      return nextLength;
    };

    child.stdout.on("data", (chunk) => {
      stdoutLength = collect(stdout, chunk, stdoutLength, "ENOBUFS");
    });
    child.stderr.on("data", (chunk) => {
      stderrLength = collect(stderr, chunk, stderrLength, "ENOBUFS");
    });
    child.on("error", (spawnError) => {
      if (error) {
        recordCleanupError(
          cleanupFailure("ECLEANUPTERMINATE", "Process cleanup emitted an error.", spawnError)
        );
        return;
      }
      error = spawnError;
      if (!child.pid) void finish(undefined, undefined, false);
    });
    child.on("close", (status, signal) => void finish(status, signal));
    const armDeadline = () => {
      if (deadlineArmedAt !== null || settled) return;
      deadlineArmedAt = performance.now();
      deadlineTimer = setTimeout(() => terminate("ETIMEDOUT"), deadlineMs);
    };
    if (!deadlineReadyFile || fs.existsSync(deadlineReadyFile)) {
      armDeadline();
    } else {
      readyPoll = setInterval(() => {
        if (!fs.existsSync(deadlineReadyFile)) return;
        clearInterval(readyPoll);
        readyPoll = null;
        if (readyTimer) clearTimeout(readyTimer);
        readyTimer = null;
        armDeadline();
      }, DEADLINE_READY_POLL_MS);
      readyTimer = setTimeout(() => terminate("EREADYTIMEOUT"), deadlineReadyTimeoutMs);
    }
  });
}

function createInjectedNoCloseChild(events) {
  const child = new EventEmitter();
  const createStream = (name) => {
    const stream = new PassThrough();
    const destroy = stream.destroy.bind(stream);
    stream.destroy = (...args) => {
      events.push(`${name}:destroy`);
      return destroy(...args);
    };
    stream.unref = () => events.push(`${name}:unref`);
    return stream;
  };
  child.pid = Math.min(MAX_UINT32 - 1, process.pid + 1_000_000);
  child.exitCode = null;
  child.signalCode = null;
  child.stdin = createStream("stdin");
  child.stdout = createStream("stdout");
  child.stderr = createStream("stderr");
  child.unref = () => events.push("child:unref");
  return child;
}

async function assertInjectedNoCloseSettlement() {
  const events = [];
  const child = createInjectedNoCloseChild(events);
  const deadlineMs = 5;
  const forceFinishMs = 30;
  const context = await spawnWithTreeDeadline("injected-no-close", [], {
    deadlineMs,
    env: process.env,
    maxBuffer: 1024,
    processTreeForceFinishMs: forceFinishMs,
    processTreeTerminationRetryMs: forceFinishMs + 100,
    spawnDeadlineChildImplementation: () => {
      queueMicrotask(() => {
        child.exitCode = 0;
        events.push("exit:0:null");
        child.emit("exit", 0, null);
      });
      return child;
    },
    terminateProcessTreeImplementation: () => {
      events.push("terminate-root");
      return true;
    },
    windowsProcessSnapshot: (pids) => {
      events.push(`snapshot:${pids.join(",")}`);
      return new Map(pids.map((pid) => [
        pid,
        { creationTime: "1", parentPid: 0, pid },
      ]));
    },
  });

  assert.equal(context.error?.code, "ETIMEDOUT");
  assert.equal(context.cleanupError?.code, "ECLEANUPTIMEOUT");
  assert.deepEqual(context.cleanupErrors.map(({ code }) => code), ["ECLEANUPTIMEOUT"]);
  assert.equal(context.closeObserved, false);
  assert.equal(context.status, undefined);
  assert.equal(context.signal, undefined);
  assert.notEqual(context.status, null);
  assert.notEqual(context.signal, null);
  assert.equal(child.exitCode, 0);
  assert.equal(child.signalCode, null);
  assert.equal(context.durationMs < 1000, true);
  assert.equal(context.deadlineDurationMs < deadlineMs + forceFinishMs + 500, true);
  assert.equal(child.stdin.destroyed, true);
  assert.equal(child.stdout.destroyed, true);
  assert.equal(child.stderr.destroyed, true);
  assert.equal(events.filter((event) => event === "stdin:unref").length, 1);
  assert.equal(events.filter((event) => event === "stdout:unref").length, 1);
  assert.equal(events.filter((event) => event === "stderr:unref").length, 1);
  assert.equal(events.filter((event) => event === "child:unref").length, 1);
  assert.equal(
    events.filter((event) => event === "terminate-root").length,
    process.platform === "win32" ? 2 : 1
  );
  assert.equal(
    events.includes("snapshot:"),
    process.platform === "win32"
  );
  assert.equal(events.indexOf("exit:0:null") < events.indexOf("terminate-root"), true);
  assert.equal(events.indexOf("terminate-root") < events.indexOf("stdout:destroy"), true);
}

async function runTopology(source = helper, environment = {}, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jumpgate-topology-"));
  try {
    const nodeShimDirectory = path.join(directory, "node-bin");
    const stateDirectory = path.join(directory, "state");
    const containerDirectory = path.join(stateDirectory, "containers");
    const recordPath = path.join(directory, "docker.record");
    const eventPath = path.join(directory, "lifecycle.record");
    const hangProcessPath = path.join(directory, "hang-process.json");
    const privateHarnessProofPath = path.join(directory, "private-harness-proof.log");
    const publicHarnessProofPath = path.join(directory, "public-harness-proof.log");
    const secretCapturePath = path.join(directory, "secret-values.capture");
    const helperPath = path.join(directory, "container-smoke-topology.sh");
    const dockerRecorderPath = path.join(directory, "docker-recorder");
    const nodeShimPath = path.join(nodeShimDirectory, "node");
    fs.mkdirSync(nodeShimDirectory, { recursive: true });
    fs.mkdirSync(containerDirectory, { recursive: true });
    fs.writeFileSync(helperPath, source, { mode: 0o700 });
    fs.writeFileSync(dockerRecorderPath, DOCKER_SHIM, { mode: 0o700 });
    fs.writeFileSync(nodeShimPath, NODE_SHIM, { mode: 0o700 });
    fs.writeFileSync(privateHarnessProofPath, PRIVATE_HARNESS_PROOF.join("\n") + "\n");
    fs.writeFileSync(publicHarnessProofPath, PUBLIC_HARNESS_PROOF.join("\n") + "\n");
    if (options.preseedLock) {
      const preseedPath = path.join(stateDirectory, `${options.preseedLock.name}.lock`);
      fs.mkdirSync(preseedPath);
      fs.writeFileSync(path.join(preseedPath, "owner"), options.preseedLock.contents);
    }

    const runnerTemp = shellPath(directory);
    const workspace = shellPath(ROOT);
    const env = {
      ...process.env,
      CONTAINER_NODE_IMAGE: IMAGES.node,
      CONTAINER_POSTGRES_IMAGE: IMAGES.postgres,
      CONTAINER_REDIS_IMAGE: IMAGES.redis,
      DOCKER_SHIM_HANG: "",
      DOCKER_SHIM_HARNESS_ENV: `${runnerTemp}/jumpgate-container/harness.env`,
      DOCKER_SHIM_HELPER: shellPath(helperPath),
      DOCKER_SHIM_EVENT_RECORD: shellPath(eventPath),
      DOCKER_SHIM_EXTRA_STDERR: "",
      DOCKER_SHIM_EXTRA_STDOUT: "",
      DOCKER_SHIM_FORCE_RM_STATUS: "",
      DOCKER_SHIM_NETWORK_RM_STATUS: "",
      DOCKER_SHIM_POSITIVE_SMOKE_STATUS: "0",
      DOCKER_SHIM_PROBE_ID: PROBE_ID,
      DOCKER_SHIM_PRIVATE_HARNESS_PROOF_FILE: shellPath(privateHarnessProofPath),
      DOCKER_SHIM_PUBLIC_HARNESS_PROOF_FILE: shellPath(publicHarnessProofPath),
      DOCKER_SHIM_PUBLIC_SMOKE_DELAY_SECONDS: "",
      DOCKER_SHIM_PUBLIC_SMOKE_STATUS: "0",
      DOCKER_SHIM_RECORD: shellPath(recordPath),
      DOCKER_SHIM_SECRET_FRAGMENT: "",
      DOCKER_SHIM_SECRET_CAPTURE: shellPath(secretCapturePath),
      DOCKER_SHIM_STATE: shellPath(stateDirectory),
      DOCKER_SHIM_NODE: shellPath(process.execPath),
      GITHUB_SHA,
      GITHUB_WORKSPACE: workspace,
      JUMPGATE_TEST_HANG_PROCESS: hangProcessPath,
      MSYS2_ARG_CONV_EXCL: "/CN",
      NODE_SHIM_HANG: "",
      RECORD_LOCK_ACQUIRE_ATTEMPTS: "200",
      RECORD_LOCK_FAIL_RELEASE: "",
      RECORD_LOCK_HOLD_SECONDS: "0",
      RECORD_LOCK_RELEASE_ATTEMPTS: "20",
      RECORD_LOCK_RETRY_DELAY: "0.005",
      RUNNER_TEMP: runnerTemp,
      ...environment,
      JUMPGATE_DOCKER_BIN: shellPath(dockerRecorderPath),
      NODE_SHIM_BIN: shellPath(nodeShimDirectory),
    };
    const waitsForHangProcess =
      env.DOCKER_SHIM_HANG === "1" || env.NODE_SHIM_HANG === "1";
    const result = await spawnWithTreeDeadline(
      bashPath(),
      ["-c", 'PATH="$NODE_SHIM_BIN:$PATH"; export PATH; exec bash "$DOCKER_SHIM_HELPER"'],
      {
        cwd: ROOT,
        deadlineMs: options.deadlineMs ?? TOPOLOGY_RUN_DEADLINE_MS,
        deadlineReadyFile: waitsForHangProcess ? hangProcessPath : undefined,
        deadlineReadyTimeoutMs: TOPOLOGY_COMPLETION_BOUND_MS,
        env,
        maxBuffer: 10 * 1024 * 1024,
        terminationPidFiles: waitsForHangProcess ? [hangProcessPath] : [],
        windowsProcessSnapshot: options.windowsProcessSnapshot,
      }
    );
    const records = readDockerRecord(recordPath);
    const events = readDockerRecord(eventPath);
    const recordText = fs.existsSync(recordPath) ? fs.readFileSync(recordPath, "utf8") : "";
    const eventText = fs.existsSync(eventPath) ? fs.readFileSync(eventPath, "utf8") : "";
    const secrets = fs.existsSync(secretCapturePath)
      ? fs.readFileSync(secretCapturePath, "utf8").split(/\r?\n/).filter(Boolean)
      : [];
    const remainingContainers = fs.readdirSync(containerDirectory);
    const networkPresent = fs.existsSync(path.join(stateDirectory, "network"));
    const residualLocks = fs
      .readdirSync(stateDirectory)
      .filter((name) => name.includes(".lock"));
    return {
      ...result,
      records,
      events,
      recordText,
      eventText,
      secrets,
      remainingContainers,
      networkPresent,
      residualLocks,
      runnerTemp,
      tempDirectory: directory,
      workspace,
    };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
}

function expectedRuns(context) {
  const runtime = `${context.runnerTemp}/jumpgate-container`;
  const network = "jumpgate-container-ci";
  const releaseImage = `jumpgate-bridge:${GITHUB_SHA}`;
  const harnessMount =
    `type=bind,src=${context.workspace}/scripts/ci/s3-protocol-harness.js,` +
    "dst=/opt/jumpgate/s3-protocol-harness.js,readonly";
  const harnessTls = `type=bind,src=${runtime}/tls/server,dst=/run/jumpgate-tls,readonly`;
  const appCa = `type=bind,src=${runtime}/tls/ca.crt,dst=/run/jumpgate-ca/ca.crt,readonly`;
  const smokeMount =
    `type=bind,src=${context.workspace}/scripts/ci/http-smoke.js,` +
    "dst=/opt/jumpgate/http-smoke.js,readonly";
  return [
    [
      "run", "--detach", "--name", "jumpgate-postgres-ci", "--network", network,
      "--network-alias", "jumpgate-postgres", "--env-file", `${runtime}/postgres.env`,
      "--health-cmd", "pg_isready -U jumpgate -d jumpgate_container_ci",
      "--health-interval", "1s", "--health-timeout", "3s", "--health-retries", "30",
      IMAGES.postgres,
    ],
    [
      "run", "--detach", "--name", "jumpgate-redis-ci", "--network", network,
      "--network-alias", "jumpgate-redis", "--health-cmd", "redis-cli ping",
      "--health-interval", "1s", "--health-timeout", "3s", "--health-retries", "30",
      IMAGES.redis,
    ],
    [
      "run", "--detach", "--name", "jumpgate-s3-ci", "--network", network,
      "--network-alias", "fly.storage.tigris.dev", "--network-alias",
      "jumpgate-ci-subtitles.fly.storage.tigris.dev", "--env-file", `${runtime}/harness.env`,
      "--mount", harnessMount, "--mount", harnessTls, IMAGES.node,
      "node", "/opt/jumpgate/s3-protocol-harness.js",
    ],
    [
      "run", "--rm", "--name", "jumpgate-release-transition-ci", "--network", network,
      "--env-file", `${runtime}/runtime.env`, "--env",
      "JUMPGATE_REDIS_PLAYBACK_CLAIM_ROLLOUT_MODE=transition", "--mount", appCa,
      releaseImage, "node", "scripts/production-release-protocols.js", "apply-env",
    ],
    [
      "run", "--rm", "--name", "jumpgate-release-v6-ci", "--network", network,
      "--env-file", `${runtime}/runtime.env`, "--env",
      "JUMPGATE_REDIS_PLAYBACK_CLAIM_ROLLOUT_MODE=v6", "--mount", appCa,
      releaseImage, "node", "scripts/production-release-protocols.js", "apply-env",
    ],
    [
      "run", "--detach", "--name", "jumpgate-bridge-ci", "--network", network,
      "--env-file", `${runtime}/runtime.env`, "--mount", appCa, releaseImage,
    ],
    [
      "run", "--name", "jumpgate-http-smoke-ci", "--network", network,
      "--mount", smokeMount, IMAGES.node, "node", "/opt/jumpgate/http-smoke.js",
      "--base-url=http://jumpgate-bridge-ci:7515", `--expected-version=${EXPECTED_VERSION}`,
      `--expected-build-sha=${GITHUB_SHA}`, "--expected-readiness=ready",
      "--deadline-ms=60000", "--delay-ms=1000",
    ],
    [
      "run", "--detach", "--name", "jumpgate-s3-ci-public", "--network", network,
      "--network-alias", "fly.storage.tigris.dev", "--network-alias",
      "jumpgate-ci-subtitles.fly.storage.tigris.dev", "--env-file", `${runtime}/harness.env`,
      "--env", "S3_HARNESS_PUBLIC_ATTESTATION=1", "--env",
      "S3_HARNESS_PUBLIC_DELAY_MS=1000", "--mount", harnessMount, "--mount", harnessTls,
      IMAGES.node, "node", "/opt/jumpgate/s3-protocol-harness.js",
    ],
    [
      "run", "--detach", "--name", "jumpgate-bridge-ci-public", "--network", network,
      "--env-file", `${runtime}/runtime.env`, "--mount", appCa, releaseImage,
    ],
    [
      "run", "--name", "jumpgate-http-smoke-ci-public", "--network", network,
      "--mount", smokeMount, IMAGES.node, "node", "/opt/jumpgate/http-smoke.js",
      "--base-url=http://jumpgate-bridge-ci-public:7515",
      `--expected-version=${EXPECTED_VERSION}`, `--expected-build-sha=${GITHUB_SHA}`,
      "--expected-readiness=not-ready", "--deadline-ms=15000", "--delay-ms=50",
    ],
  ];
}

function commandKey(command) {
  return JSON.stringify(command);
}

function assertCommandMultiset(actual, expected, label) {
  assert.deepEqual(
    actual.map(commandKey).sort(),
    expected.map(commandKey).sort(),
    label
  );
}

function commandsBy(records, name) {
  return records.filter((command) => command[0] === name);
}

function assertSecretFixturesIsolated(context) {
  assert.equal(context.secrets.length, 9, "generated secret fixture must be captured");
  assert.equal(new Set(context.secrets).size, context.secrets.length);
  const channels = [
    context.recordText,
    context.eventText,
    JSON.stringify(context.records),
    JSON.stringify(context.events),
  ];
  for (const secret of context.secrets) {
    assert.equal(secret.length >= 16, true);
    for (const channel of channels) {
      assert.equal(channel.includes(secret), false, "generated secret escaped a test channel");
    }
  }
}

function expectedHarnessLog(label) {
  if (label.endsWith("app")) return ["redaction-safe application log"];
  if (label.includes("positive-s3")) {
    return [
      JSON.stringify({
        schema: "jumpgate-s3-harness-v2",
        event: "ready",
        probeId: PROBE_ID,
        mode: "private",
      }),
      ...PRIVATE_HARNESS_PROOF,
    ];
  }
  if (label.includes("public-s3")) {
    return [
      JSON.stringify({
        schema: "jumpgate-s3-harness-v2",
        event: "ready",
        probeId: PROBE_ID,
        mode: "public",
      }),
      ...PUBLIC_HARNESS_PROOF,
    ];
  }
  throw new Error(`unexpected redacted log label: ${label}`);
}

function expectedRecordingStdout(context) {
  const lines = [];
  const hasPublicProbe = context.records.some(
    (command) => command[0] === "run" && command.includes("jumpgate-http-smoke-ci-public")
  );
  for (const event of context.events) {
    if (event[0] === "docker" && event[1] === "run") {
      const nameIndex = event.indexOf("--name");
      if (event[nameIndex + 1] === "jumpgate-http-smoke-ci") {
        lines.push("HTTP smoke passed: live, ready, version, manifest, configure.");
      }
      continue;
    }
    if (event[0] !== "node") continue;
    const [, command, label, phase, status] = event;
    if (phase === "begin") {
      const messages = {
        generate: "Container smoke environment generated.",
        audit: "Container smoke log contains no generated secrets.",
        redact: "Container smoke log redacted.",
        "verify-private-lifecycle": "Private S3 lifecycle log verified.",
        "verify-public-attestation": "Public S3 attestation log verified.",
      };
      assert.ok(messages[command], `unexpected recording command output: ${command}`);
      lines.push(messages[command]);
      continue;
    }
    if (phase === "end" && command === "redact" && status === "0") {
      lines.push(`::group::Redacted ${label} log`, ...expectedHarnessLog(label), "::endgroup::");
    }
    if (
      phase === "end" &&
      command === "verify-public-attestation" &&
      label === "public-s3-attestation" &&
      status === "0" &&
      hasPublicProbe
    ) {
      lines.push("HTTP smoke passed: live and negative readiness attestation.");
    }
  }
  return lines.length === 0 ? "" : lines.join("\n") + "\n";
}

function assertExactRecordingOutput(context, { cleanupFailed = false } = {}) {
  assert.equal(context.stdout.replace(/\r\n/g, "\n"), expectedRecordingStdout(context));
  assert.equal(
    context.stderr.replace(/\r\n/g, "\n"),
    cleanupFailed ? "Container smoke topology cleanup failed.\n" : ""
  );
}

function eventIndex(events, expected, start = 0) {
  return events.findIndex(
    (event, index) => index >= start && commandKey(event) === commandKey(expected)
  );
}

function assertCapturePipeline(context, container, label) {
  const auditBegin = eventIndex(context.events, ["node", "audit", label, "begin"]);
  assert.notEqual(auditBegin, -1, `missing audit for ${label}`);
  let logIndex = -1;
  for (let index = auditBegin - 1; index >= 0; index -= 1) {
    if (commandKey(context.events[index]) === commandKey(["docker", "logs", container])) {
      logIndex = index;
      break;
    }
  }
  assert.notEqual(logIndex, -1, `missing log capture for ${label}`);
  const auditEnd = context.events.findIndex(
    (event, index) =>
      index > auditBegin &&
      event[0] === "node" &&
      event[1] === "audit" &&
      event[2] === label &&
      event[3] === "end"
  );
  const redactBegin = eventIndex(
    context.events,
    ["node", "redact", label, "begin"],
    auditEnd + 1
  );
  const redactEnd = eventIndex(
    context.events,
    ["node", "redact", label, "end", "0"],
    redactBegin + 1
  );
  const forceRemoval = context.events.findIndex(
    (event) => event[0] === "docker" && event[1] === "rm" && event[2] === "--force"
  );
  assert.equal(
    logIndex < auditBegin &&
      auditBegin < auditEnd &&
      auditEnd < redactBegin &&
      redactBegin < redactEnd &&
      redactEnd < forceRemoval,
    true,
    `capture pipeline ordering failed for ${label}`
  );
}

function assertFailureCleanup(context, expectedStatus, captures) {
  assert.equal(context.status, expectedStatus, context.stderr || context.stdout);
  assert.deepEqual(context.residualLocks, []);
  assert.equal(fs.existsSync(context.tempDirectory), false);
  assertExactRecordingOutput(context, { cleanupFailed: true });
  assertSecretFixturesIsolated(context);
  assert.notEqual(
    context.remainingContainers.length,
    0,
    "injected force-removal failure must exercise no-masking behavior"
  );
  assert.equal(context.networkPresent, false);
  assert.deepEqual(
    commandsBy(context.records, "rm")
      .filter((command) => command[1] === "--force")
      .map((command) => command[2]),
    CLEANUP_CONTAINERS
  );
  assert.equal(
    commandsBy(context.records, "network").some(
      (command) => commandKey(command) === commandKey(["network", "rm", "jumpgate-container-ci"])
    ),
    true
  );
  for (const [container, label] of captures) {
    assertCapturePipeline(context, container, label);
  }
}

function validateRecording(context) {
  assert.equal(
    context.status,
    0,
    JSON.stringify({
      stderr: context.stderr,
      remainingContainers: context.remainingContainers,
      networkPresent: context.networkPresent,
      cleanupRemovals: commandsBy(context.records, "rm").filter((command) =>
        command.includes("--force")
      ),
    })
  );
  assert.deepEqual(context.remainingContainers, [], "successful recording left containers behind");
  assert.equal(context.networkPresent, false, "successful recording left its network behind");
  assert.deepEqual(context.residualLocks, [], "successful recording left a recorder lock behind");
  assert.equal(fs.existsSync(context.tempDirectory), false, "topology temp tree was not removed");
  assertExactRecordingOutput(context);
  assertSecretFixturesIsolated(context);
  const records = context.records;
  assert.deepEqual(commandsBy(records, "run"), expectedRuns(context));
  assert.deepEqual(
    commandsBy(records, "pull"),
    [["pull", IMAGES.node], ["pull", IMAGES.postgres], ["pull", IMAGES.redis]]
  );
  assertCommandMultiset(
    commandsBy(records, "network"),
    [
      ["network", "create", "--driver", "bridge", "--internal", "jumpgate-container-ci"],
      ["network", "rm", "jumpgate-container-ci"],
      ["network", "inspect", "jumpgate-container-ci"],
    ],
    "network lifecycle must be exact"
  );
  assertCommandMultiset(
    commandsBy(records, "inspect"),
    [
      ["inspect", "--format", "{{.State.Health.Status}}", "jumpgate-postgres-ci"],
      ["inspect", "--format", "{{.State.Health.Status}}", "jumpgate-redis-ci"],
      ["inspect", "--format", "{{.Image}}", "jumpgate-bridge-ci"],
      ["inspect", "--format", "{{.Image}}", "jumpgate-bridge-ci-public"],
    ],
    "runtime inspect calls must be exact"
  );
  assertCommandMultiset(
    commandsBy(records, "image"),
    [
      ["image", "inspect", "--format", "{{.Id}}", `jumpgate-bridge:${GITHUB_SHA}`],
      ["image", "inspect", "--format", "{{.Id}}", `jumpgate-bridge:${GITHUB_SHA}`],
    ],
    "release image inspections must be exact"
  );
  assertCommandMultiset(
    commandsBy(records, "logs"),
    [
      ["logs", "jumpgate-s3-ci"],
      ["logs", "jumpgate-bridge-ci"],
      ["logs", "jumpgate-s3-ci"],
      ["logs", "jumpgate-s3-ci-public"],
      ["logs", "jumpgate-s3-ci-public"],
      ["logs", "jumpgate-s3-ci-public"],
      ["logs", "jumpgate-bridge-ci-public"],
      ["logs", "jumpgate-s3-ci-public"],
    ],
    "redacted log capture sequence must have no extra source"
  );
  const captureInspects = [
    "jumpgate-bridge-ci",
    "jumpgate-s3-ci",
    "jumpgate-s3-ci-public",
    "jumpgate-bridge-ci-public",
    "jumpgate-s3-ci-public",
    "jumpgate-bridge-ci",
    "jumpgate-s3-ci",
    "jumpgate-bridge-ci-public",
    "jumpgate-s3-ci-public",
    ...CLEANUP_CONTAINERS,
  ].map((name) => ["container", "inspect", name]);
  assertCommandMultiset(
    commandsBy(records, "container"),
    captureInspects,
    "container inspection and cleanup inventory must be exact"
  );
  assert.deepEqual(commandsBy(records, "stop"), [
    ["stop", "--time", "10", "jumpgate-bridge-ci", "jumpgate-s3-ci"],
    ["stop", "--time", "10", "jumpgate-bridge-ci-public", "jumpgate-s3-ci-public"],
  ]);
  assert.deepEqual(commandsBy(records, "rm"), [
    ["rm", "jumpgate-http-smoke-ci"],
    ["rm", "jumpgate-bridge-ci", "jumpgate-s3-ci"],
    ["rm", "jumpgate-http-smoke-ci-public"],
    ["rm", "jumpgate-bridge-ci-public", "jumpgate-s3-ci-public"],
    ...CLEANUP_CONTAINERS.map((name) => ["rm", "--force", name]),
  ]);
  assert.deepEqual(
    [...new Set(records.map((command) => command[0]))].sort(),
    ["container", "image", "inspect", "logs", "network", "pull", "rm", "run", "stop"]
  );

  const runNames = commandsBy(records, "run").map((command) => {
    const nameIndex = command.indexOf("--name");
    assert.notEqual(nameIndex, -1);
    return command[nameIndex + 1];
  });
  assert.deepEqual(runNames, RUN_ORDER);

  const positiveRun = records.findIndex((command) => command.includes("jumpgate-http-smoke-ci"));
  const positiveRemove = records.findIndex(
    (command) => commandKey(command) === commandKey(["rm", "jumpgate-http-smoke-ci"])
  );
  const positiveStop = records.findIndex(
    (command) => commandKey(command) === commandKey([
      "stop", "--time", "10", "jumpgate-bridge-ci", "jumpgate-s3-ci",
    ])
  );
  const positiveAppLog = records.findIndex(
    (command) => commandKey(command) === commandKey(["logs", "jumpgate-bridge-ci"])
  );
  assert.equal(positiveRun < positiveRemove && positiveRemove < positiveStop, true);
  assert.equal(positiveStop < positiveAppLog, true);

  const publicRun = records.findIndex((command) =>
    command.includes("jumpgate-http-smoke-ci-public") && command[0] === "run"
  );
  const publicRemove = records.findIndex(
    (command) => commandKey(command) === commandKey(["rm", "jumpgate-http-smoke-ci-public"])
  );
  const publicStop = records.findIndex(
    (command) => commandKey(command) === commandKey([
      "stop", "--time", "10", "jumpgate-bridge-ci-public", "jumpgate-s3-ci-public",
    ])
  );
  const publicAppLog = records.findIndex(
    (command) => commandKey(command) === commandKey(["logs", "jumpgate-bridge-ci-public"])
  );
  assert.equal(publicRun < publicRemove && publicRemove < publicStop, true);
  assert.equal(publicStop < publicAppLog, true);

  const output = context.stdout.replace(/\r\n/g, "\n");
  const positiveMessage = output.indexOf("HTTP smoke passed: live, ready");
  const positiveLogs = output.indexOf("::group::Redacted positive-app log");
  const privateProof = output.indexOf("Private S3 lifecycle log verified.");
  assert.equal(positiveMessage < positiveLogs && positiveLogs < privateProof, true);
  const firstPublicProof = output.indexOf("Public S3 attestation log verified.");
  const negativeMessage = output.indexOf("HTTP smoke passed: live and negative readiness");
  const publicLogs = output.indexOf("::group::Redacted public-app log");
  const finalPublicProof = output.lastIndexOf("Public S3 attestation log verified.");
  assert.equal(
    firstPublicProof < negativeMessage &&
      negativeMessage < publicLogs &&
      publicLogs < finalPublicProof,
    true
  );
}

async function assertHelperMutationRejected(mutated) {
  const execution = await runTopology(mutated);
  assert.equal(execution.status, 0, execution.stderr || execution.stdout);
  assertSecretFixturesIsolated(execution);
  assert.throws(() => validateRecording(execution), assert.AssertionError);
}

test("helper source seals the readonly Docker execution contract", async (t) => {
  validateHelperContract(helper);
  const marker = 'docker_cli pull "$CONTAINER_NODE_IMAGE" >/dev/null\n';
  const inject = (command) => replaceOnce(helper, marker, `${command}\n${marker}`);
  const cases = [
    ["command -p Docker", "command -p docker version"],
    ["absolute Docker path", "/usr/bin/docker version"],
    ["literal Docker command", "docker version"],
    ["Docker host override", "DOCKER_HOST=tcp://127.0.0.1:2375 docker_cli version"],
    ["Docker API override", "DOCKER_API_VERSION=1.44 docker_cli version"],
    ["Docker socket access", "test -S /var/run/docker.sock"],
    ["eval escape", "eval '\"$DOCKER_BIN\" version'"],
    ["nested shell escape", "bash -c '\"$DOCKER_BIN\" version'"],
    ["unsupported external command", "python3 -c 'print(1)'"],
  ];
  for (const [name, command] of cases) {
    await t.test(name, () =>
      assert.throws(() => validateHelperContract(inject(command)), assert.AssertionError)
    );
  }
});

test("workflow structurally contains exactly one unoverridden topology invocation", () => {
  validateWorkflow(workflow);
});

test("workflow structurally seals the Kodi version parity gate", () => {
  assert.throws(
    () => validateWorkflow(replaceOnce(workflow, VERSION_PARITY_INVOCATION, `${VERSION_PARITY_INVOCATION} || true`)),
    assert.AssertionError
  );
  assert.throws(
    () => validateWorkflow(replaceOnce(workflow, VERSION_PARITY_INVOCATION, "true")),
    assert.AssertionError
  );
  assert.throws(
    () =>
      validateWorkflow(
        replaceOnce(
          workflow,
          "  fingerprint-parity:\n    name: Bridge / Kodi fingerprint parity",
          "  fingerprint-parity:\n    continue-on-error: true\n    name: Bridge / Kodi fingerprint parity"
        )
      ),
    assert.AssertionError
  );
  assert.throws(
    () =>
      validateWorkflow(
        replaceOnce(workflow, "      - fingerprint-parity\n", "")
      ),
    assert.AssertionError
  );
  assert.throws(
    () =>
      validateWorkflow(
        replaceOnce(
          workflow,
          "      github.ref == 'refs/heads/main' &&",
          "      always() && github.ref == 'refs/heads/main' &&"
        )
      ),
    assert.AssertionError
  );
});

test("recording Docker shim proves the complete expanded immutable topology", async () => {
  validateRecording(await runTopology(helper, { EXPECTED_VERSION: "9.9.9" }));
});

test("record lock recovery is bounded and never guesses an owner", async (t) => {
  await t.test("dead owner is quarantined and recovered", async () => {
    const context = await runTopology(helper, {}, {
      preseedLock: { name: "event", contents: "2147483647 stale-owner\n" },
    });
    validateRecording(context);
    assert.equal(context.durationMs < TOPOLOGY_COMPLETION_BOUND_MS, true);
  });
  await t.test("unverifiable owner fails bounded without stealing", async () => {
    const context = await runTopology(
      helper,
      {
        RECORD_LOCK_ACQUIRE_ATTEMPTS: "3",
        RECORD_LOCK_RELEASE_ATTEMPTS: "3",
        RECORD_LOCK_RETRY_DELAY: "0.005",
      },
      {
        deadlineMs: TOPOLOGY_FAILURE_DEADLINE_MS,
        preseedLock: { name: "event", contents: "unverifiable-owner\n" },
      }
    );
    assert.equal(context.status, 70, context.stderr || context.stdout);
    assert.equal(context.error, null);
    assert.equal(context.durationMs < TOPOLOGY_FAILURE_DEADLINE_MS, true);
    assert.deepEqual(context.residualLocks, ["event.lock"]);
    assert.equal(fs.existsSync(context.tempDirectory), false);
    const diagnostics = context.stderr.trim().split(/\r?\n/);
    assert.equal(diagnostics.length > 0, true);
    assert.equal(diagnostics.every((line) => line === "Topology recorder lock failed."), true);
  });
});

test("forced concurrent public smoke keeps atomic parseable records", async () => {
  const context = await runTopology(helper, {
    DOCKER_SHIM_PUBLIC_SMOKE_DELAY_SECONDS: "0.2",
    RECORD_LOCK_HOLD_SECONDS: "0.01",
  });
  validateRecording(context);
  assert.equal(context.durationMs < TOPOLOGY_COMPLETION_BOUND_MS, true);
  assert.deepEqual(context.residualLocks, []);
});

test("lock release failure is bounded, nonzero, and leaves no process hang", async () => {
  const context = await runTopology(
    helper,
    {
      RECORD_LOCK_ACQUIRE_ATTEMPTS: "5",
      RECORD_LOCK_FAIL_RELEASE: "event",
      RECORD_LOCK_RELEASE_ATTEMPTS: "3",
      RECORD_LOCK_RETRY_DELAY: "0.005",
    },
    { deadlineMs: TOPOLOGY_FAILURE_DEADLINE_MS }
  );
  assert.equal(context.status, 70, context.stderr || context.stdout);
  assert.equal(context.error, null);
  assert.equal(context.durationMs < TOPOLOGY_FAILURE_DEADLINE_MS, true);
  assert.deepEqual(context.residualLocks, ["event.lock"]);
  assert.equal(fs.existsSync(context.tempDirectory), false);
  const diagnostics = context.stderr.trim().split(/\r?\n/);
  assert.equal(diagnostics.length > 0, true);
  assert.equal(diagnostics.every((line) => line === "Topology recorder lock failed."), true);
});

test("Windows supervisor atomically assigns its Job and restricts inherited handles", () => {
  assert.match(
    WINDOWS_JOB_SUPERVISOR_SCRIPT,
    /InitializeProcThreadAttributeList\(IntPtr\.Zero, 2, 0, ref attributeListSize\)/
  );
  assert.match(
    WINDOWS_JOB_SUPERVISOR_SCRIPT,
    /InitializeProcThreadAttributeList\(attributeList, 2, 0, ref attributeListSize\)/
  );
  assert.match(WINDOWS_JOB_SUPERVISOR_SCRIPT, /SetHandleInformation\(handle,/);
  assert.match(WINDOWS_JOB_SUPERVISOR_SCRIPT, /SetHandleInformation\(restore\)/);
  assert.match(WINDOWS_JOB_SUPERVISOR_SCRIPT, /Marshal\.FreeHGlobal\(handleList\)/);
  assert.match(WINDOWS_JOB_SUPERVISOR_SCRIPT, /CloseHandle\(process\.hThread\)/);
  assert.match(WINDOWS_JOB_SUPERVISOR_SCRIPT, /CloseHandle\(process\.hProcess\)/);

  const jobAttribute = WINDOWS_JOB_SUPERVISOR_SCRIPT.indexOf(
    "new IntPtr(PROC_THREAD_ATTRIBUTE_JOB_LIST)"
  );
  const handleAttribute = WINDOWS_JOB_SUPERVISOR_SCRIPT.indexOf(
    "new IntPtr(PROC_THREAD_ATTRIBUTE_HANDLE_LIST)"
  );
  const createProcess = WINDOWS_JOB_SUPERVISOR_SCRIPT.indexOf("created = CreateProcess(");
  const resumeThread = WINDOWS_JOB_SUPERVISOR_SCRIPT.indexOf("ResumeThread(process.hThread)");
  assert.equal(jobAttribute >= 0 && jobAttribute < handleAttribute, true);
  assert.equal(handleAttribute < createProcess && createProcess < resumeThread, true);
  assert.match(
    WINDOWS_JOB_SUPERVISOR_SCRIPT.slice(createProcess, resumeThread),
    /true,\s+CREATE_SUSPENDED \| EXTENDED_STARTUPINFO_PRESENT/
  );

  const finallyBlock = WINDOWS_JOB_SUPERVISOR_SCRIPT.indexOf("finally");
  const closeJob = WINDOWS_JOB_SUPERVISOR_SCRIPT.indexOf("CloseHandle(job)", finallyBlock);
  const closeThread = WINDOWS_JOB_SUPERVISOR_SCRIPT.indexOf(
    "CloseHandle(process.hThread)",
    finallyBlock
  );
  assert.equal(finallyBlock >= 0 && closeJob < closeThread, true);
});

test("delayed Windows verification uses valid sub-two-second spawnSync timeouts", async () => {
  const pid = 2_000_000_001;
  const creationTime = "638890000000000000";
  const expected = new Map([[pid, { creationTime, parentPid: 0, pid }]]);
  const observedTimeouts = [];
  let snapshots = 0;
  const snapshot = (pids, timeoutMs) => snapshotWindowsProcessIdentities(
    pids,
    timeoutMs,
    (_command, _args, options) => {
      observedTimeouts.push(options.timeout);
      snapshots += 1;
      return {
        error: null,
        signal: null,
        status: 0,
        stdout: snapshots === 1 ? `${pid}:0:${creationTime}\n` : "",
      };
    }
  );

  await waitForWindowsProcessIdentitiesToExit(expected, snapshot, 40);
  assert.equal(observedTimeouts.length >= 2, true);
  assert.equal(
    observedTimeouts.every((timeout) =>
      Number.isInteger(timeout) && timeout > 0 && timeout <= 40 && timeout <= MAX_UINT32
    ),
    true
  );
  assert.equal(normalizeSpawnSyncTimeout(0.01, 2000), 1);
  assert.equal(normalizeSpawnSyncTimeout(1.01, 2000), 2);
  assert.equal(normalizeSpawnSyncTimeout(MAX_UINT32 + 10, MAX_UINT32), MAX_UINT32);
});

test("process liveness treats only Linux dead states and ESRCH as terminated", () => {
  const pid = 42;
  const optionsForStat = (stat, probeProcess = () => undefined) => ({
    platform: "linux",
    probeProcess,
    readProcessStat: () => stat,
  });
  const throwsCode = (code) => () => {
    throw Object.assign(new Error(code), { code });
  };

  assert.equal(isProcessAlive(pid, optionsForStat("42 (node) Z 1")), false);
  assert.equal(isProcessAlive(pid, optionsForStat("42 (node) X 1")), false);
  assert.equal(isProcessAlive(pid, optionsForStat("42 (node ) worker) x 1")), false);
  assert.equal(isProcessAlive(pid, optionsForStat("42 (node) S 1")), true);
  assert.equal(isProcessAlive(pid, optionsForStat("42 node) Z 1")), true);
  assert.equal(isProcessAlive(pid, optionsForStat(") X 1")), true);
  assert.equal(isProcessAlive(pid, optionsForStat("43 (node) Z 1")), true);
  assert.equal(
    isProcessAlive(pid, optionsForStat("malformed", throwsCode("ESRCH"))),
    true
  );
  assert.equal(
    isProcessAlive(pid, {
      platform: "linux",
      probeProcess: throwsCode("ESRCH"),
      readProcessStat: throwsCode("ENOENT"),
    }),
    false
  );
  assert.equal(
    isProcessAlive(pid, {
      platform: "linux",
      probeProcess: throwsCode("EPERM"),
      readProcessStat: throwsCode("EACCES"),
    }),
    true
  );
});

test(
  "Windows supervisor closes its Job and internal handles after an observed target exit",
  { skip: process.platform !== "win32" },
  async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jumpgate-handle-proof-"));
    const descendantPath = path.join(directory, "descendant.pid");
    try {
      const context = await spawnWithTreeDeadline(
        process.execPath,
        [
          "-e",
          'const { spawn } = require("node:child_process"); ' +
            'const fs = require("node:fs"); ' +
            'const descendant = spawn(process.execPath, ["-e", ' +
            '"setInterval(() => {}, 300000)"], { stdio: "inherit", windowsHide: true }); ' +
            'descendant.unref(); ' +
            'fs.writeFileSync(process.env.JUMPGATE_HANDLE_DESCENDANT_FILE, String(descendant.pid));',
        ],
        {
          cwd: ROOT,
          deadlineMs: 10000,
          env: { ...process.env, JUMPGATE_HANDLE_DESCENDANT_FILE: descendantPath },
          maxBuffer: 1024,
        }
      );
      assert.equal(context.error, null, context.stderr || context.stdout);
      assert.equal(context.cleanupError, null);
      assert.deepEqual(context.cleanupErrors, []);
      assert.equal(context.closeObserved, true);
      assert.equal(context.status, 0, context.stderr || context.stdout);
      assert.equal(context.signal, null);
      const descendantPid = Number(fs.readFileSync(descendantPath, "utf8"));
      assert.equal(isTerminationPid(descendantPid), true);
      assert.equal(isProcessAlive(descendantPid), false);
      assert.equal(isProcessAlive(context.pid), false);
    } finally {
      fs.rmSync(directory, { force: true, recursive: true });
    }
  }
);

test("hard deadline terminates the complete Bash and Node process trees", async (t) => {
  const stressIterations = Number(process.env.JUMPGATE_NODE_DEADLINE_STRESS_ITERATIONS || "1");
  assert.equal(Number.isSafeInteger(stressIterations) && stressIterations >= 1, true);
  const cases = stressIterations > 1
    ? [["Node recorder descendant", { NODE_SHIM_HANG: "1" }]]
    : [
    ["Docker recorder descendant", { DOCKER_SHIM_HANG: "1" }],
    ["Node recorder descendant", { NODE_SHIM_HANG: "1" }],
  ];
  for (let iteration = 0; iteration < stressIterations; iteration += 1) {
    for (const [name, environment] of cases) await t.test(
      stressIterations > 1 ? `${name} ${iteration + 1}/${stressIterations}` : name,
      async () => {
      const deadlineMs = 750;
      const context = await runTopology(helper, environment, { deadlineMs });
      assert.equal(context.error?.code, "ETIMEDOUT");
      assert.equal(context.cleanupError, null);
      assert.equal(context.closeObserved, true);
      assert.equal(context.status, null);
      assert.equal(context.signal, "SIGKILL");
      assert.equal(context.terminationPids.length >= 3, true);
      assert.equal(context.terminationPids.every((pid) => !isProcessAlive(pid)), true);
      assert.deepEqual(commandsBy(context.records, "rm"), []);
      assert.equal(
        context.deadlineDurationMs + DEADLINE_EARLY_TOLERANCE_MS >= deadlineMs,
        true
      );
      assert.equal(
        context.deadlineDurationMs < deadlineMs + PROCESS_TREE_TERMINATION_GRACE_MS,
        true
      );
      assert.equal(isProcessAlive(context.pid), false);
      assert.equal(fs.existsSync(context.tempDirectory), false);
      }
    );
  }
});

test(
  "hard deadline snapshot failure fails closed through the Windows Job Object",
  { skip: process.platform !== "win32" },
  async (t) => {
    const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 300000)"], {
      stdio: "ignore",
      windowsHide: true,
    });
    t.after(() => {
      if (unrelated.exitCode === null && unrelated.signalCode === null) {
        unrelated.kill("SIGKILL");
      }
    });
    const unrelatedSnapshot = snapshotWindowsProcessIdentities([unrelated.pid]);
    const unrelatedIdentity = unrelatedSnapshot.get(unrelated.pid);
    assert.ok(unrelatedIdentity, "unrelated process identity must be observable");
    const staleIdentity = new Map([
      [
        unrelated.pid,
        {
          ...unrelatedIdentity,
          creationTime: (BigInt(unrelatedIdentity.creationTime) - 1n).toString(),
        },
      ],
    ]);
    assert.deepEqual(matchingWindowsProcessIdentities(staleIdentity, unrelatedSnapshot), []);

    const cases = [
      [
        "snapshot command failure",
        () => {
          throw new Error("injected Windows process snapshot failure");
        },
        "ECLEANUPSNAPSHOT",
      ],
      ["incomplete creation-time identity", () => new Map(), "ECLEANUPIDENTITY"],
    ];
    for (const [name, windowsProcessSnapshot, cleanupCode] of cases) {
      await t.test(name, async () => {
        const deadlineMs = 250;
        const context = await runTopology(
          helper,
          { NODE_SHIM_HANG: "1" },
          { deadlineMs, windowsProcessSnapshot }
        );
        assert.equal(context.error?.code, "ETIMEDOUT");
        assert.equal(context.cleanupError?.code, cleanupCode);
        assert.equal(context.closeObserved, true);
        assert.equal(context.status, null);
        assert.equal(context.signal, "SIGKILL");
        assert.equal(context.terminationPids.length >= 3, true);
        assert.equal(context.terminationPids.every((pid) => !isProcessAlive(pid)), true);
        assert.deepEqual(commandsBy(context.records, "rm"), []);
        assert.equal(isProcessAlive(context.pid), false);
        assert.equal(isProcessAlive(unrelated.pid), true);
        assert.equal(
          context.deadlineDurationMs < deadlineMs + PROCESS_TREE_TERMINATION_GRACE_MS,
          true
        );
        assert.equal(fs.existsSync(context.tempDirectory), false);
      });
    }
  }
);

test("hard deadline fails closed when descendant readiness never arrives", async () => {
  const readyTimeoutMs = 50;
  const context = await spawnWithTreeDeadline(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)"],
    {
      cwd: ROOT,
      deadlineMs: 1000,
      deadlineReadyFile: path.join(
        os.tmpdir(),
        `jumpgate-missing-deadline-ready-${process.pid}-${Date.now()}`
      ),
      deadlineReadyTimeoutMs: readyTimeoutMs,
      env: process.env,
      maxBuffer: 1024,
    }
  );
  assert.equal(context.error?.code, "EREADYTIMEOUT");
  assert.equal(context.cleanupError, null);
  assert.equal(context.closeObserved, true);
  assert.equal(context.deadlineDurationMs, null);
  assert.equal(context.status, null);
  assert.equal(context.signal, "SIGKILL");
  assert.equal(
    context.durationMs + DEADLINE_EARLY_TOLERANCE_MS >= readyTimeoutMs,
    true
  );
  assert.equal(
    context.durationMs < readyTimeoutMs + PROCESS_TREE_TERMINATION_GRACE_MS,
    true
  );
  assert.equal(isProcessAlive(context.pid), false);
});

test("hard deadline duration ignores backward wall-clock movement", async () => {
  const originalNow = Date.now;
  let reads = 0;
  Date.now = () => (reads++ === 0 ? 10_000 : 9_000);
  try {
    const deadlineMs = 50;
    const context = await spawnWithTreeDeadline(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { cwd: ROOT, deadlineMs, env: process.env, maxBuffer: 1024 }
    );
    assert.equal(context.error?.code, "ETIMEDOUT");
    assert.equal(context.closeObserved, true);
    assert.equal(context.status, null);
    assert.equal(context.signal, "SIGKILL");
    assert.equal(
      context.deadlineDurationMs + DEADLINE_EARLY_TOLERANCE_MS >= deadlineMs,
      true
    );
  } finally {
    Date.now = originalNow;
  }
});

test(
  "deadline runner bounds injected Windows terminal state without an observed close",
  { skip: process.platform !== "win32", timeout: 2000 },
  assertInjectedNoCloseSettlement
);

test(
  "deadline runner bounds injected POSIX terminal state without an observed close",
  { skip: process.platform === "win32", timeout: 2000 },
  assertInjectedNoCloseSettlement
);

test(
  "deadline runner kills the original POSIX group after its leader exits with inherited stdio",
  { skip: process.platform === "win32", timeout: 7000 },
  async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jumpgate-posix-close-proof-"));
    const descendantPath = path.join(directory, "descendant.json");
    let descendantPid = null;
    try {
      const leaderScript = [
        '"use strict";',
        'const { spawn } = require("node:child_process");',
        'const fs = require("node:fs");',
        'const descendant = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"],',
        '  { stdio: "inherit" });',
        "descendant.unref();",
        "fs.writeFileSync(process.env.JUMPGATE_POSIX_DESCENDANT_FILE,",
        "  JSON.stringify({ proofPids: [descendant.pid] }), { mode: 0o600 });",
        "process.exit(0);",
      ].join(" ");
      const deadlineMs = 100;
      const context = await spawnWithTreeDeadline(process.execPath, ["-e", leaderScript], {
        cwd: ROOT,
        deadlineMs,
        deadlineReadyFile: descendantPath,
        deadlineReadyTimeoutMs: 1000,
        env: { ...process.env, JUMPGATE_POSIX_DESCENDANT_FILE: descendantPath },
        maxBuffer: 1024,
        terminationPidFiles: [descendantPath],
      });
      descendantPid = JSON.parse(fs.readFileSync(descendantPath, "utf8")).proofPids[0];

      assert.equal(context.error?.code, "ETIMEDOUT");
      assert.equal(context.cleanupError, null);
      assert.deepEqual(context.cleanupErrors, []);
      assert.equal(context.closeObserved, true);
      assert.equal(context.status, 0);
      assert.equal(context.signal, null);
      assert.deepEqual(context.terminationPids, [descendantPid]);
      assert.equal(isProcessAlive(context.pid), false);
      assert.equal(
        context.deadlineDurationMs + DEADLINE_EARLY_TOLERANCE_MS >= deadlineMs,
        true
      );
      assert.equal(
        context.deadlineDurationMs < deadlineMs + PROCESS_TREE_TERMINATION_GRACE_MS,
        true
      );
    } finally {
      if (isProcessAlive(descendantPid)) {
        try {
          process.kill(descendantPid, "SIGKILL");
        } catch {
          // The descendant exited between the liveness check and cleanup.
        }
      }
      fs.rmSync(directory, { force: true, recursive: true });
    }
  }
);

test("deadline runner preserves the observed child close status and streams", async () => {
  const context = await spawnWithTreeDeadline(
    process.execPath,
    [
      "-e",
      'process.stdout.write("observed stdout"); ' +
        'process.stderr.write("observed stderr"); process.exitCode = 37;',
    ],
    { cwd: ROOT, deadlineMs: 10000, env: process.env, maxBuffer: 1024 }
  );
  assert.equal(context.error, null);
  assert.equal(context.cleanupError, null);
  assert.deepEqual(context.cleanupErrors, []);
  assert.equal(context.closeObserved, true);
  assert.equal(context.status, 37);
  assert.equal(context.signal, null);
  assert.equal(context.stdout, "observed stdout");
  assert.equal(context.stderr, "observed stderr");
});

test("otherwise successful smoke fails closed when cleanup fails", async (t) => {
  const cases = [
    [
      "force-removal failure",
      { DOCKER_SHIM_FORCE_RM_STATUS: "41" },
      ["jumpgate-postgres-ci", "jumpgate-redis-ci"],
      false,
    ],
    ["network-removal failure", { DOCKER_SHIM_NETWORK_RM_STATUS: "43" }, [], true],
  ];
  for (const [name, environment, remainingContainers, networkPresent] of cases) {
    await t.test(name, async () => {
      const context = await runTopology(helper, environment);
      assert.equal(context.status, 1, context.stderr || context.stdout);
      assertExactRecordingOutput(context, { cleanupFailed: true });
      assertSecretFixturesIsolated(context);
      assert.deepEqual(context.remainingContainers.sort(), remainingContainers);
      assert.equal(context.networkPresent, networkPresent);
      assert.deepEqual(context.residualLocks, []);
      assert.equal(fs.existsSync(context.tempDirectory), false);
      assert.equal(
        (context.stdout + context.stderr).includes("Container smoke topology completed."),
        false
      );
    });
  }
});

test("recording output rejects every non-allowlisted byte", async (t) => {
  const cases = [
    ["base64 text", { DOCKER_SHIM_EXTRA_STDOUT: "c2VjcmV0LWZpeHR1cmU=" }],
    ["hex text", { DOCKER_SHIM_EXTRA_STDOUT: "deadbeef01234567" }],
    ["generated secret fragment", { DOCKER_SHIM_SECRET_FRAGMENT: "1" }],
    ["stderr text", { DOCKER_SHIM_EXTRA_STDERR: "unexpected diagnostic" }],
  ];
  for (const [name, environment] of cases) {
    await t.test(name, async () => {
      const context = await runTopology(helper, environment);
      assert.equal(context.status, 0, context.stderr || context.stdout);
      assertSecretFixturesIsolated(context);
      assert.throws(() => assertExactRecordingOutput(context), assert.AssertionError);
      assert.throws(() => validateRecording(context), assert.AssertionError);
    });
  }
});

test("phase failures preserve status and redact logs before force-removal", async (t) => {
  const releaseCleanup = [["jumpgate-s3-ci", "cleanup-positive-s3"]];
  const positiveCleanup = [
    ["jumpgate-bridge-ci", "cleanup-positive-app"],
    ["jumpgate-s3-ci", "cleanup-positive-s3"],
  ];
  const publicCleanup = [
    ["jumpgate-bridge-ci-public", "cleanup-public-app"],
    ["jumpgate-s3-ci-public", "cleanup-public-s3"],
  ];
  const cases = [
    [
      "transition release protocol",
      {
        TOPOLOGY_FAIL_PHASE: "docker:run:jumpgate-release-transition-ci",
        TOPOLOGY_FAIL_STATUS: "20",
      },
      20,
      releaseCleanup,
    ],
    [
      "v6 release protocol",
      {
        TOPOLOGY_FAIL_PHASE: "docker:run:jumpgate-release-v6-ci",
        TOPOLOGY_FAIL_STATUS: "24",
      },
      24,
      releaseCleanup,
    ],
    [
      "positive application start",
      { TOPOLOGY_FAIL_PHASE: "docker:run:jumpgate-bridge-ci", TOPOLOGY_FAIL_STATUS: "21" },
      21,
      positiveCleanup,
    ],
    [
      "positive application image status",
      { TOPOLOGY_BAD_IMAGE_CONTAINER: "jumpgate-bridge-ci" },
      1,
      positiveCleanup,
    ],
    [
      "positive probe status",
      { DOCKER_SHIM_POSITIVE_SMOKE_STATUS: "17" },
      17,
      positiveCleanup,
    ],
    [
      "positive application log",
      { TOPOLOGY_FAIL_PHASE: "docker:logs:jumpgate-bridge-ci", TOPOLOGY_FAIL_STATUS: "31" },
      1,
      [["jumpgate-bridge-ci", "positive-app"], ...positiveCleanup],
    ],
    [
      "positive application audit",
      { TOPOLOGY_FAIL_PHASE: "node:audit:positive-app", TOPOLOGY_FAIL_STATUS: "33" },
      1,
      [["jumpgate-bridge-ci", "positive-app"], ...positiveCleanup],
    ],
    [
      "private lifecycle status",
      {
        TOPOLOGY_FAIL_PHASE: "node:verify-private-lifecycle:positive-s3",
        TOPOLOGY_FAIL_STATUS: "35",
      },
      35,
      [
        ["jumpgate-bridge-ci", "positive-app"],
        ["jumpgate-s3-ci", "positive-s3"],
        ...positiveCleanup,
      ],
    ],
    [
      "public application start",
      {
        TOPOLOGY_FAIL_PHASE: "docker:run:jumpgate-bridge-ci-public",
        TOPOLOGY_FAIL_STATUS: "22",
      },
      22,
      publicCleanup,
    ],
    [
      "public application image status",
      { TOPOLOGY_BAD_IMAGE_CONTAINER: "jumpgate-bridge-ci-public" },
      1,
      publicCleanup,
    ],
    [
      "public probe status",
      { DOCKER_SHIM_PUBLIC_SMOKE_STATUS: "19" },
      19,
      [["jumpgate-s3-ci-public", "public-s3-attestation"], ...publicCleanup],
    ],
    [
      "public application log",
      {
        TOPOLOGY_FAIL_PHASE: "docker:logs:jumpgate-bridge-ci-public",
        TOPOLOGY_FAIL_STATUS: "32",
      },
      1,
      [["jumpgate-bridge-ci-public", "public-app"], ...publicCleanup],
    ],
    [
      "public application audit",
      { TOPOLOGY_FAIL_PHASE: "node:audit:public-app", TOPOLOGY_FAIL_STATUS: "34" },
      1,
      [["jumpgate-bridge-ci-public", "public-app"], ...publicCleanup],
    ],
    [
      "public attestation audit",
      {
        TOPOLOGY_FAIL_PHASE: "node:audit:public-s3-attestation",
        TOPOLOGY_FAIL_STATUS: "36",
      },
      1,
      [["jumpgate-s3-ci-public", "public-s3-attestation"], ...publicCleanup],
    ],
    [
      "public attestation status",
      {
        TOPOLOGY_FAIL_PHASE: "node:verify-public-attestation:public-s3-attestation",
        TOPOLOGY_FAIL_STATUS: "37",
      },
      37,
      [["jumpgate-s3-ci-public", "public-s3-attestation"], ...publicCleanup],
    ],
  ];
  for (const [name, environment, status, captures] of cases) {
    await t.test(name, async () => {
      const context = await runTopology(helper, {
        ...environment,
        DOCKER_SHIM_FORCE_RM_STATUS: "29",
      });
      assertFailureCleanup(context, status, captures);
    });
  }
});

test("workflow structure mutations cannot alter the sealed job", async (t) => {
  const block = `      - name: ${STEP_NAME}\n        run: ${HELPER_INVOCATION}\n`;
  const propertyMutation = (property) =>
    replaceOnce(
      workflow,
      block,
      `      - name: ${STEP_NAME}\n${property}        run: ${HELPER_INVOCATION}\n`
    );
  const jobMutation = (property) =>
    replaceOnce(workflow, "  container-smoke:\n    name:", `  container-smoke:\n${property}    name:`);
  const cases = [
    ["duplicate target step", replaceOnce(workflow, block, block + block)],
    [
      "hidden second invocation",
      replaceOnce(
        workflow,
        block,
        block + "      - name: Hidden topology\n        run: " + HELPER_INVOCATION + "\n"
      ),
    ],
    ["target if override", propertyMutation("        if: always()\n")],
    ["target continue-on-error", propertyMutation("        continue-on-error: true\n")],
    ["target custom shell", propertyMutation("        shell: sh\n")],
    ["target working directory", propertyMutation("        working-directory: /tmp\n")],
    [
      "target environment override",
      propertyMutation("        env:\n          DOCKER_CONFIG: /tmp/docker-config\n"),
    ],
    ["target timeout override", propertyMutation("        timeout-minutes: 1\n")],
    ["target unsupported key", propertyMutation("        permissions: write-all\n")],
    ["job Docker environment", jobMutation("    env:\n      DOCKER_HOST: tcp://evil:2375\n")],
    ["job custom defaults", jobMutation("    defaults:\n      run:\n        shell: sh\n")],
    ["job image override", jobMutation("    container: node:latest\n")],
    ["job unsupported key", jobMutation("    continue-on-error: true\n")],
    [
      "global custom shell",
      replaceOnce(workflow, "defaults:\n  run:\n    shell: bash", "defaults:\n  run:\n    shell: sh"),
    ],
    [
      "prior GITHUB_ENV write",
      replaceOnce(workflow, block, '          echo "DOCKER_HOST=x" >> "$GITHUB_ENV"\n' + block),
    ],
    [
      "prior GITHUB_PATH write",
      replaceOnce(workflow, block, '          echo "/tmp/evil" >> "$GITHUB_PATH"\n' + block),
    ],
    [
      "prior shell startup mutation",
      replaceOnce(workflow, block, '          echo "export NODE_OPTIONS=x" >> "$HOME/.bashrc"\n' + block),
    ],
    [
      "extra pre-helper executable step",
      replaceOnce(workflow, block, "      - name: Hidden setup\n        run: true\n" + block),
    ],
    [
      "early artifact export",
      replaceOnce(
        workflow,
        block,
        "      - name: Early export\n        run: docker save jumpgate-bridge\n" + block
      ),
    ],
    [
      "export ignores helper failure",
      replaceOnce(workflow, "          success() &&\n", "          always() &&\n"),
    ],
    [
      "duplicate YAML run key",
      replaceOnce(
        workflow,
        `        run: ${HELPER_INVOCATION}\n`,
        `        run: ${HELPER_INVOCATION}\n        run: true\n`
      ),
    ],
    ...[
      "DOCKER_HOST",
      "DOCKER_CONTEXT",
      "DOCKER_CONFIG",
      "DOCKER_API_VERSION",
      "DOCKER_CERT_PATH",
      "DOCKER_TLS_VERIFY",
      "JUMPGATE_DOCKER_BIN",
      "NODE_OPTIONS",
      "BASH_ENV",
      "ENV",
      "SHELLOPTS",
      "BASHOPTS",
      "PATH",
    ].map((name) => [
      `global ${name} override`,
      replaceOnce(workflow, "env:\n  NODE_VERSION:", `env:\n  ${name}: injected\n  NODE_VERSION:`),
    ]),
  ];
  for (const [name, mutated] of cases) {
    await t.test(name, () => assert.throws(() => validateWorkflow(mutated)));
  }
});

test("expanded argv rejects probe environment and mount injection", async (t) => {
  const smokeMount =
    '  --mount "type=bind,src=$GITHUB_WORKSPACE/scripts/ci/http-smoke.js,' +
    'dst=/opt/jumpgate/http-smoke.js,readonly" \\\n';
  const cases = [
    [
      "NODE_OPTIONS environment",
      replaceOnce(helper, smokeMount, "  --env NODE_OPTIONS=--require=/tmp/evil.js \\\n" + smokeMount),
    ],
    [
      "probe env file",
      replaceOnce(helper, smokeMount, '  --env-file "$env_file" \\\n' + smokeMount),
    ],
    [
      "extra mount",
      replaceOnce(
        helper,
        smokeMount,
        '  --mount "type=bind,src=$GITHUB_WORKSPACE,dst=/tmp/extra,readonly" \\\n' +
          smokeMount
      ),
    ],
    [
      "writable smoke mount",
      replaceOnce(helper, smokeMount, smokeMount.replace(",readonly", "")),
    ],
  ];
  for (const [name, mutated] of cases) {
    await t.test(name, () => assertHelperMutationRejected(mutated));
  }
});

test("expanded argv rejects image, publish, and hidden Docker mutations", async (t) => {
  const positiveRun = "docker_cli run \\\n  --name jumpgate-http-smoke-ci \\\n";
  const positiveExecutable =
    '  "$CONTAINER_NODE_IMAGE" \\\n  node /opt/jumpgate/http-smoke.js \\\n';
  const afterNetwork =
    'docker_cli network create --driver bridge --internal "$network" >/dev/null\n\n';
  const extraRun =
    'docker_cli run --name jumpgate-extra-ci --network "$network" "$CONTAINER_NODE_IMAGE" true';
  const cases = [
    [
      "unpinned harness image",
      replaceOnce(
        helper,
        '  "$CONTAINER_NODE_IMAGE" \\\n  node /opt/jumpgate/s3-protocol-harness.js',
        "  node:24-alpine \\\n  node /opt/jumpgate/s3-protocol-harness.js"
      ),
    ],
    [
      "inserted true executable",
      replaceOnce(
        helper,
        positiveExecutable,
        positiveExecutable.replace("  node /opt", "  true node /opt")
      ),
    ],
    [
      "entrypoint override",
      replaceOnce(helper, positiveRun, positiveRun + "  --entrypoint true \\\n"),
    ],
    [
      "long publish",
      replaceOnce(helper, positiveRun, positiveRun + "  --publish 7515:7515 \\\n"),
    ],
    [
      "equals publish",
      replaceOnce(helper, positiveRun, positiveRun + "  --publish=7515:7515 \\\n"),
    ],
    [
      "publish all",
      replaceOnce(helper, positiveRun, positiveRun + "  --publish-all \\\n"),
    ],
    [
      "short publish",
      replaceOnce(helper, positiveRun, positiveRun + "  -p 7515:7515 \\\n"),
    ],
    [
      "compact short publish",
      replaceOnce(helper, positiveRun, positiveRun + "  -p7515:7515 \\\n"),
    ],
    [
      "short publish all",
      replaceOnce(helper, positiveRun, positiveRun + "  -P \\\n"),
    ],
    [
      "variable-expanded publish flag",
      replaceOnce(
        helper,
        positiveRun,
        "publish_flag=--publish-all\n" + positiveRun + '  "$publish_flag" \\\n'
      ),
    ],
    [
      "secondary run network",
      replaceOnce(helper, positiveRun, positiveRun + "  --network secondary \\\n"),
    ],
    [
      "network connect",
      replaceOnce(
        helper,
        afterNetwork,
        afterNetwork + "docker_cli network connect secondary jumpgate-postgres-ci\n"
      ),
    ],
    ["indented Docker run", replaceOnce(helper, afterNetwork, afterNetwork + `  ${extraRun}\n`)],
    [
      "split Docker run",
      replaceOnce(
        helper,
        afterNetwork,
        afterNetwork + extraRun.replace("docker_cli run", "docker_cli \\\n  run") + "\n"
      ),
    ],
    [
      "command-substitution Docker run",
      replaceOnce(helper, afterNetwork, afterNetwork + `: "$(${extraRun})"\n`),
    ],
  ];
  for (const [name, mutated] of cases) {
    await t.test(name, () => assertHelperMutationRejected(mutated));
  }
});
