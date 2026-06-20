import { describe, expect, test } from "bun:test";
import { classifyCommand, splitSegments, stripWrappers } from "../src/classify";

const v = (cmd: string, opts?: Parameters<typeof classifyCommand>[1]) =>
  classifyCommand(cmd, opts).verdict;

describe("read-only commands", () => {
  const reads = [
    "ls -la /var/log",
    "cat /etc/hostname",
    "grep -n ERROR app.log | head -n 50",
    "tail -f /var/log/order/order-svc.log",
    "wc -l file",
    "kubectl get pods -n order",
    "kubectl -n order get pods", // global flag before verb
    "kubectl describe pod order-0",
    "kubectl logs -l app=order-svc --tail=100",
    "kubectl top pod -n order",
    "kubectl config view",
    "kubectl auth can-i get pods",
    "git status",
    "git log --oneline -5",
    "git -C /repo diff HEAD~1",
    "git rev-parse HEAD",
    "helm list -n order",
    "docker ps -a",
    "docker inspect order",
    "systemctl status nginx",
    "journalctl -u nginx --since -5m",
    "jstack 1234",
    "arthas jad com.foo.Bar",
    "arthas sc -d com.foo.Bar",
    "sed -n '1,5p' file",
    "sort -u file",
    "find . -name '*.log'",
    "timeout 5 grep x file",
    "nice -n 10 cat f",
    "env LANG=C ls",
    "LANG=C TZ=UTC ls -l",
    "ps aux",
  ];
  for (const c of reads) test(`read: ${c}`, () => expect(v(c)).toBe("read"));
});

describe("mutating commands (=> ask)", () => {
  const mutates = [
    "mv a b",
    "cp a b",
    "kubectl delete pod order-0",
    "kubectl apply -f x.yaml",
    "kubectl exec order-0 -- sh",
    "kubectl -n order rollout restart deploy/order-svc",
    "kubectl scale deploy/order-svc --replicas=3",
    "kubectl edit deploy/order-svc",
    "docker run -it alpine sh",
    "docker exec order sh",
    "systemctl restart nginx",
    "git push origin main",
    "git checkout -b feature",
    "git commit -m x",
    "helm install order ./chart",
    "echo hi > /tmp/out",
    "echo hi >> /tmp/out",
    "cat $(which ls)",
    "cat `hostname`",
    "diff <(ls) <(ls /tmp)",
    "grep x f && rm f",
    "ls; mv a b",
    "sudo ls",
    "su - root",
    "sed -i s/a/b/ f",
    "awk '{print}' f",
    "sort -o out.txt f",
    "find . -delete",
    "find . -exec rm {} ;",
    "tee /tmp/f",
    "someproprietary status",
    "kubectl config set-context x",
    "kubectl auth reconcile",
    "arthas redefine /tmp/Foo.class",
    "arthas watch com.foo.Bar method",
  ];
  for (const c of mutates) test(`mutate: ${c}`, () => expect(v(c)).toBe("mutate"));
});

describe("catastrophic commands (=> deny)", () => {
  const denies = [
    "rm -rf /",
    "rm -rf /tmp/x",
    "rm -fr /var",
    "mkfs.ext4 /dev/sdb",
    "dd if=/dev/zero of=/dev/sda bs=1M",
    ":(){ :|:& };:",
    "shutdown -h now",
    "reboot",
    "init 0",
    "echo x > /dev/sda",
  ];
  for (const c of denies) test(`deny: ${c}`, () => expect(v(c)).toBe("deny"));
});

describe("proprietary CLI verb table", () => {
  const opts = {
    proprietaryReadOnly: [
      { binary: "envctl", verbs: ["show", "status", "ls"] },
      { binary: "roview" }, // whole-binary read-only
    ],
  };
  test("known read verb => read", () => expect(v("envctl show svc", opts)).toBe("read"));
  test("read verb after global flag => read", () =>
    expect(v("envctl --json status svc", opts)).toBe("read"));
  test("unknown verb => mutate", () => expect(v("envctl restart svc", opts)).toBe("mutate"));
  test("whole-binary read-only => read", () =>
    expect(v("roview anything here", opts)).toBe("read"));
  test("without opts the proprietary binary is unknown => mutate", () =>
    expect(v("envctl show svc")).toBe("mutate"));
});

describe("edge cases", () => {
  test("empty => mutate", () => expect(v("")).toBe("mutate"));
  test("whitespace => mutate", () => expect(v("   ")).toBe("mutate"));
  test("2>/dev/null is allowed on a read command", () =>
    expect(v("grep x f 2>/dev/null")).toBe("read"));
  test("compound all-read => read", () => expect(v("ls | grep x | head")).toBe("read"));
});

describe("helpers", () => {
  test("splitSegments splits on operators", () => {
    expect(splitSegments("a && b | c ; d")).toEqual(["a", "b", "c", "d"]);
  });
  test("splitSegments single", () => {
    expect(splitSegments("ls -la")).toEqual(["ls -la"]);
  });
  test("stripWrappers removes timeout + duration", () => {
    expect(stripWrappers("timeout 5 grep x f")).toBe("grep x f");
  });
  test("stripWrappers removes env assignments", () => {
    expect(stripWrappers("LANG=C TZ=UTC ls -l")).toBe("ls -l");
  });
  test("stripWrappers removes env binary + assignments", () => {
    expect(stripWrappers("env FOO=1 cat f")).toBe("cat f");
  });
  test("stripWrappers nested wrappers", () => {
    expect(stripWrappers("nice -n 10 nohup tail -f log")).toBe("tail -f log");
  });
});

describe("hardening (Codex review H3/H4/H5)", () => {
  test("split/long-flag rm -rf are catastrophic deny", () => {
    expect(v("rm -r -f /tmp/x")).toBe("deny");
    expect(v("rm --recursive --force /tmp/x")).toBe("deny");
    expect(v("rm -fr /tmp/x")).toBe("deny");
    expect(v("ls && rm -r -f /tmp/x")).toBe("deny");
  });
  test("rm without both recursive+force is mutate, not deny", () => {
    expect(v("rm -r /tmp/x")).toBe("mutate");
    expect(v("rm file")).toBe("mutate");
  });
  test("nested docker/git subcommands are not read", () => {
    expect(v("docker image rm alpine")).toBe("mutate");
    expect(v("docker image prune -a")).toBe("mutate");
    expect(v("git config user.name pwned")).toBe("mutate");
    expect(v("git branch newbranch")).toBe("mutate");
    expect(v("git remote add x url")).toBe("mutate");
    expect(v("git tag v1")).toBe("mutate");
  });
  test("docker/git reads still read", () => {
    expect(v("docker ps -a")).toBe("read");
    expect(v("docker images")).toBe("read");
    expect(v("git status")).toBe("read");
    expect(v("git log --oneline")).toBe("read");
  });
  test("JVM attach write tools are not read", () => {
    expect(v("jmap -dump:format=b,file=/tmp/heap.hprof 1234")).toBe("mutate");
    expect(v("jinfo -flag +PrintGC 1234")).toBe("mutate");
  });
  test("jstack/jps/pgrep/pidof remain read", () => {
    expect(v("jstack 1234")).toBe("read");
    expect(v("jps -l")).toBe("read");
    expect(v("pgrep -f order-svc.jar")).toBe("read");
    expect(v("pidof java")).toBe("read");
  });
  test("sed write modes are not read", () => {
    expect(v("sed --in-place s/a/b/ f")).toBe("mutate");
    expect(v("sed -i s/a/b/ f")).toBe("mutate");
    expect(v("sed -n 'w /tmp/out' f")).toBe("mutate");
    expect(v("sed -n '1,5p' f")).toBe("read");
  });
  test("find file-writing primaries are not read", () => {
    expect(v("find . -fprint0 /tmp/list")).toBe("mutate");
    expect(v("find . -fprintf /tmp/o '%p'")).toBe("mutate");
    expect(v("find . -name '*.log'")).toBe("read");
  });
});
