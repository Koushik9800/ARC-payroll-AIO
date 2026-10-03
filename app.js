(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const EMP_KEY = "arcPayrollEmployeesV1";
  const HIST_KEY = "arcPayrollHistoryV1";
  const NET_KEY = "arcPayrollNetworkV1";

  let selectedNetwork = localStorage.getItem(NET_KEY) || "testnet";
  let provider = null;
  let signer = null;
  let account = null;
  let pendingPayroll = [];
  let pendingPaymentMode = "batch";

  let employees = loadJson(EMP_KEY, []);
  let history = loadJson(HIST_KEY, []);

  function loadJson(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback)); }
    catch { return fallback; }
  }
  function saveAll() {
    localStorage.setItem(EMP_KEY, JSON.stringify(employees));
    localStorage.setItem(HIST_KEY, JSON.stringify(history));
  }
  function network() { return ARC_CONFIG[selectedNetwork]; }

  function showMessage(text, type = "") {
    const el = $("message");
    el.textContent = text;
    el.className = "message " + type;
    clearTimeout(showMessage.timer);
    showMessage.timer = setTimeout(() => el.classList.add("hidden"), 7000);
  }

  function shortAddr(a) {
    return a ? a.slice(0, 6) + "…" + a.slice(-4) : "—";
  }

  function money(n) {
    return Number(n || 0).toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 6});
  }

  function monthKey(date = new Date()) {
    const d = new Date(date);
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`;
  }

  function initHistoryMonths() {
    const select = $("historyMonth");
    const months = new Set(history.map(x => x.month));
    months.add(monthKey());
    const arr = [...months].sort().reverse();
    select.innerHTML = arr.map(m => `<option value="${m}">${m}</option>`).join("");
    renderHistory();
  }

  async function connectWallet() {
    if (!window.ethereum) {
      showMessage("No EVM wallet detected. Install MetaMask or another compatible wallet.", "error");
      return;
    }
    try {
      await switchNetwork(true);
      provider = new ethers.BrowserProvider(window.ethereum);
      await provider.send("eth_requestAccounts", []);
      signer = await provider.getSigner();
      account = await signer.getAddress();
      $("connectBtn").classList.add("hidden");
      $("disconnectBtn").classList.remove("hidden");
      $("walletAddress").textContent = shortAddr(account);
      await refreshBalance();
      showMessage(`Connected: ${shortAddr(account)}`, "success");
    } catch (e) {
      showMessage(cleanError(e), "error");
    }
  }

  async function switchNetwork(autoAdd = false) {
    if (!window.ethereum) throw new Error("No EVM wallet detected.");
    const n = network();
    try {
      await window.ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: n.chainHex }]
      });
    } catch (e) {
      if (e.code === 4902) {
        const params = {
          chainId: n.chainHex,
          chainName: n.name,
          nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
          rpcUrls: [n.rpc],
          blockExplorerUrls: [n.explorer]
        };
        await window.ethereum.request({ method: "wallet_addEthereumChain", params: [params] });
      } else throw e;
    }
  }

  async function handleNetworkChange() {
    selectedNetwork = $("networkSelect").value;
    localStorage.setItem(NET_KEY, selectedNetwork);
    updateNetworkUI();
    if (window.ethereum && account) {
      try {
        await switchNetwork(false);
        provider = new ethers.BrowserProvider(window.ethereum);
        signer = await provider.getSigner();
        await refreshBalance();
        showMessage(`Switched to ${network().name}`, "success");
      } catch (e) {
        showMessage("Network switch cancelled or unavailable.", "error");
      }
    }
  }

  async function refreshBalance() {
    if (!account) return;
    try {
      provider = provider || new ethers.BrowserProvider(window.ethereum);
      const token = new ethers.Contract(network().usdc, USDC_ABI, provider);
      const [tokenRaw, nativeRaw] = await Promise.all([
        token.balanceOf(account),
        provider.getBalance(account)
      ]);
      $("usdcBalance").textContent = money(ethers.formatUnits(tokenRaw, 6)) + " USDC";
      $("nativeBalance").textContent = "Gas balance: " + money(ethers.formatUnits(nativeRaw, 18)) + " USDC";
    } catch (e) {
      showMessage("Could not read the USDC balance: " + cleanError(e), "error");
    }
  }

  function updateNetworkUI() {
    const n = network();
    $("networkSelect").value = selectedNetwork;
    $("networkName").textContent = n.name;
    $("chainIdText").textContent = "Chain " + n.chainId;
    $("network-dot")?.classList?.remove("x");
  }

  function renderEmployees() {
    const query = $("employeeSearch").value.trim().toLowerCase();
    const rows = employees.filter(e =>
      !query || e.name.toLowerCase().includes(query) || e.wallet.toLowerCase().includes(query)
    );
    $("employeeCount").textContent = employees.length;
    $("emptyEmployees").classList.toggle("hidden", rows.length !== 0);

    $("employeeTable").innerHTML = rows.map(e => {
      const last = [...history].reverse().find(h => h.employeeId === e.id && h.status === "paid");
      return `<tr>
        <td><div class="employee-name">${escapeHtml(e.name)}</div><div class="muted">${escapeHtml(e.id)}</div></td>
        <td class="wallet">${escapeHtml(shortAddr(e.wallet))}</td>
        <td>${money(e.salary)} USDC</td>
        <td>${last ? '<span class="status paid">Paid</span>' : '<span class="status pending">Ready</span>'}</td>
        <td><div class="actions">
          <button class="btn mini" data-pay="${e.id}">Pay</button>
          <button class="btn mini" data-edit="${e.id}">Edit</button>
          <button class="btn mini" data-remove="${e.id}">Remove</button>
        </div></td>
      </tr>`;
    }).join("");
  }

  function renderHistory() {
    const selected = $("historyMonth").value || monthKey();
    const rows = history.filter(h => h.month === selected).sort((a,b) => b.timestamp - a.timestamp);
    $("emptyHistory").classList.toggle("hidden", rows.length !== 0);
    $("historyTable").innerHTML = rows.map(h => {
      const tx = h.txHash && h.txHash.startsWith("0x")
        ? `<a href="${network().explorer}/tx/${h.txHash}" target="_blank" rel="noopener">${shortAddr(h.txHash)}</a>`
        : "—";
      const salary = Number(h.salary ?? h.amount ?? 0);
      const bonus = Number(h.bonus ?? 0);
      const total = Number(h.amount ?? salary + bonus);
      return `<tr>
        <td>${new Date(h.timestamp).toLocaleString()}</td>
        <td>${escapeHtml(h.employeeName)}</td>
        <td>${money(salary)} USDC</td>
        <td>${money(bonus)} USDC</td>
        <td><strong>${money(total)} USDC</strong></td>
        <td><span class="status ${h.status}">${h.status}</span></td>
        <td>${tx}</td>
      </tr>`;
    }).join("");

    const currentMonth = monthKey();
    const paid = history.filter(h => h.month === currentMonth && h.status === "paid");
    const total = paid.reduce((s,h) => s + Number(h.amount || 0), 0);
    $("monthPaid").textContent = money(total) + " USDC";
    $("monthPayments").textContent = paid.length + " payments";
  }

  function openEmployeeModal(employee = null) {
    $("employeeForm").reset();
    $("employeeId").value = employee?.id || "";
    $("employeeName").value = employee?.name || "";
    $("employeeWallet").value = employee?.wallet || "";
    $("employeeSalary").value = employee?.salary || "";
    $("modalTitle").textContent = employee ? "Edit Employee" : "Add Employee";
    $("employeeModal").classList.remove("hidden");
  }

  function closeEmployeeModal() { $("employeeModal").classList.add("hidden"); }

  function saveEmployee(e) {
    e.preventDefault();
    const id = $("employeeId").value || "EMP-" + Date.now().toString(36).toUpperCase();
    const name = $("employeeName").value.trim();
    const walletRaw = $("employeeWallet").value.trim();
    const salary = Number($("employeeSalary").value);

    if (!name) return showMessage("Employee name is required.", "error");
    if (!ethers.isAddress(walletRaw)) return showMessage("Invalid wallet address.", "error");
    if (!(salary > 0)) return showMessage("Salary must be greater than zero.", "error");

    const wallet = ethers.getAddress(walletRaw);
    const duplicate = employees.find(x => x.wallet.toLowerCase() === wallet.toLowerCase() && x.id !== id);
    if (duplicate) return showMessage("That wallet is already assigned to another employee.", "error");

    const record = { id, name, wallet, salary };
    const index = employees.findIndex(x => x.id === id);
    if (index >= 0) employees[index] = record; else employees.push(record);
    saveAll(); closeEmployeeModal(); renderEmployees();
    showMessage("Employee saved. The wallet is now part of your payroll list.", "success");
  }

  function removeEmployee(id) {
    const emp = employees.find(x => x.id === id);
    if (!emp) return;
    if (!confirm(`Remove ${emp.name} from payroll? Future payrolls will not include this wallet.`)) return;
    employees = employees.filter(x => x.id !== id);
    saveAll(); renderEmployees();
    showMessage(`${emp.name} removed from the active payroll list.`, "success");
  }

  function openConfirm(list, mode = "batch") {
    if (!list.length) return showMessage("Select at least one employee.", "error");
    pendingPaymentMode = mode;
    pendingPayroll = list.map(e => ({ ...e, bonus: 0 }));
    renderConfirmBody();
    $("confirmModal").classList.remove("hidden");
  }

  function renderConfirmBody() {
    const total = pendingPayroll.reduce((s,e) => s + Number(e.salary) + Number(e.bonus || 0), 0);
    const title = pendingPaymentMode === "single" ? "Single Payment" : "Batch Payment";
    $("confirmTitle").textContent = title;
    $("confirmBody").innerHTML = `
      <div class="payment-summary"><strong>${pendingPayroll.length}</strong> employee${pendingPayroll.length > 1 ? "s" : ""} · <strong id="confirmTotal">${money(total)} USDC</strong></div>
      <div class="confirm-list">
        ${pendingPayroll.map((e, i) => `
          <div class="confirm-row payment-row">
            <div>
              <strong>${escapeHtml(e.name)}</strong>
              <div class="muted">Salary: ${money(e.salary)} USDC</div>
            </div>
            <label class="bonus-field">Bonus
              <input type="number" min="0" step="0.000001" value="${Number(e.bonus || 0)}" data-bonus-index="${i}" aria-label="Bonus for ${escapeHtml(e.name)}">
            </label>
          </div>`).join("")}
      </div>`;
    $("confirmPayBtn").textContent = pendingPaymentMode === "single" ? "Confirm & Pay" : "Confirm Batch Payment";
  }

  async function payEmployee(emp) {
    openConfirm([emp], "single");
  }

  async function executePayroll() {
    if (!account || !signer) {
      showMessage("Connect your company wallet first.", "error");
      return;
    }
    if (!pendingPayroll.length) return;

    $("confirmPayBtn").disabled = true;
    try {
      await switchNetwork(false);
      provider = new ethers.BrowserProvider(window.ethereum);
      signer = await provider.getSigner();
      const token = new ethers.Contract(network().usdc, USDC_ABI, signer);

      for (const emp of pendingPayroll) {
        const salary = Number(emp.salary);
        const bonus = Number(emp.bonus || 0);
        if (bonus < 0) throw new Error(`Bonus cannot be negative for ${emp.name}.`);
        const total = salary + bonus;
        const amount = ethers.parseUnits(String(total), 6);

        const balance = await token.balanceOf(account);
        if (balance < amount) {
          throw new Error(`Insufficient USDC balance for ${emp.name}.`);
        }

        const tx = await token.transfer(emp.wallet, amount);
        addHistory(emp, "pending", tx.hash, salary, bonus, total);
        renderHistory();
        showMessage(`Payment submitted for ${emp.name}. Waiting for confirmation...`);

        try {
          await tx.wait();
          updateHistory(tx.hash, "paid");
          showMessage(`${emp.name} paid ${money(total)} USDC successfully.`, "success");
        } catch {
          updateHistory(tx.hash, "failed");
          throw new Error(`Transaction failed for ${emp.name}.`);
        }
        renderHistory();
      }

      saveAll();
      await refreshBalance();
      $("confirmModal").classList.add("hidden");
      pendingPayroll = [];
      renderEmployees();
    } catch (e) {
      showMessage(cleanError(e), "error");
    } finally {
      $("confirmPayBtn").disabled = false;
    }
  }

  function addHistory(emp, status, txHash, salary = Number(emp.salary), bonus = 0, amount = salary + bonus) {
    history.push({
      id: "TX-" + Date.now().toString(36),
      employeeId: emp.id,
      employeeName: emp.name,
      salary: Number(salary),
      bonus: Number(bonus),
      amount: Number(amount),
      status,
      txHash,
      month: monthKey(),
      timestamp: Date.now(),
      network: selectedNetwork
    });
    saveAll();
  }

  function updateHistory(txHash, status) {
    const item = history.find(x => x.txHash === txHash);
    if (item) item.status = status;
    saveAll();
  }

  function bulkPayroll() {
    if (!employees.length) return showMessage("Add employees before starting payroll.", "error");
    openConfirm(employees, "batch");
  }

  function importCsv(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const lines = String(reader.result).split(/\r?\n/).filter(Boolean);
        if (lines.length < 2) throw new Error("CSV is empty.");
        const headers = lines.shift().split(",").map(x => x.trim().toLowerCase());
        const idI = headers.indexOf("id"), nameI = headers.indexOf("name"), walletI = headers.indexOf("wallet"), salaryI = headers.indexOf("salary");
        if (nameI < 0 || walletI < 0 || salaryI < 0) throw new Error("CSV needs name,wallet,salary columns.");
        let added = 0;
        for (const line of lines) {
          const cols = parseCsvLine(line);
          const name = (cols[nameI] || "").trim();
          const walletRaw = (cols[walletI] || "").trim();
          const salary = Number(cols[salaryI]);
          if (!name || !ethers.isAddress(walletRaw) || !(salary > 0)) continue;
          const wallet = ethers.getAddress(walletRaw);
          if (employees.some(x => x.wallet.toLowerCase() === wallet.toLowerCase())) continue;
          employees.push({
            id: (cols[idI] || "").trim() || "EMP-" + Math.random().toString(36).slice(2,8).toUpperCase(),
            name, wallet, salary
          });
          added++;
        }
        saveAll(); renderEmployees();
        showMessage(`${added} employee${added === 1 ? "" : "s"} imported.`, "success");
      } catch(e) { showMessage(cleanError(e), "error"); }
    };
    reader.readAsText(file);
  }

  function parseCsvLine(line) {
    const out = []; let cur = "", quoted = false;
    for (let i=0;i<line.length;i++) {
      const c = line[i];
      if (c === '"' && line[i+1] === '"') { cur += '"'; i++; continue; }
      if (c === '"') { quoted = !quoted; continue; }
      if (c === "," && !quoted) { out.push(cur); cur = ""; } else cur += c;
    }
    out.push(cur); return out;
  }

  function exportCsv() {
    const month = $("historyMonth").value || monthKey();
    const rows = history.filter(h => h.month === month);
    const csv = [["Date","Employee","Salary USDC","Bonus USDC","Total USDC","Status","Tx Hash","Network"],
      ...rows.map(h => [new Date(h.timestamp).toISOString(), h.employeeName, h.salary ?? h.amount, h.bonus ?? 0, h.amount, h.status, h.txHash || "", h.network])];
    const blob = new Blob([csv.map(r => r.map(csvCell).join(",")).join("\n")], {type:"text/csv"});
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `arc-payroll-${month}.csv`; a.click();
    URL.revokeObjectURL(a.href);
  }

  function csvCell(v) { return `"${String(v).replaceAll('"','""')}"`; }
  function escapeHtml(v) { return String(v).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c])); }
  function cleanError(e) {
    const msg = e?.shortMessage || e?.reason || e?.message || String(e);
    if (/user rejected|denied|rejected/i.test(msg)) return "Transaction or network switch was rejected in the wallet.";
    return msg.replace(/^Error:\s*/,"").slice(0, 240);
  }

  $("networkSelect").addEventListener("change", handleNetworkChange);
  $("connectBtn").addEventListener("click", connectWallet);
  $("disconnectBtn").addEventListener("click", () => {
    account = null; provider = null; signer = null;
    $("connectBtn").classList.remove("hidden"); $("disconnectBtn").classList.add("hidden");
    $("walletAddress").textContent = "Wallet not connected"; $("usdcBalance").textContent = "—"; $("nativeBalance").textContent = "Gas: —";
  });
  $("addEmployeeBtn").addEventListener("click", () => openEmployeeModal());
  $("cancelModal").addEventListener("click", closeEmployeeModal);
  $("closeModal").addEventListener("click", closeEmployeeModal);
  $("employeeForm").addEventListener("submit", saveEmployee);
  $("employeeSearch").addEventListener("input", renderEmployees);
  $("bulkBtn").addEventListener("click", bulkPayroll);
  $("csvBtn").addEventListener("click", () => $("csvInput").click());
  $("csvInput").addEventListener("change", e => { if(e.target.files[0]) importCsv(e.target.files[0]); e.target.value=""; });
  $("historyMonth").addEventListener("change", renderHistory);
  $("exportBtn").addEventListener("click", exportCsv);
  $("cancelConfirm").addEventListener("click", () => { $("confirmModal").classList.add("hidden"); pendingPayroll=[]; });
  $("closeConfirm").addEventListener("click", () => { $("confirmModal").classList.add("hidden"); pendingPayroll=[]; });
  $("confirmBody").addEventListener("input", e => {
    const input = e.target.closest("[data-bonus-index]");
    if (!input) return;
    const index = Number(input.dataset.bonusIndex);
    const value = Number(input.value || 0);
    if (pendingPayroll[index]) pendingPayroll[index].bonus = Number.isFinite(value) && value >= 0 ? value : 0;
    const total = pendingPayroll.reduce((s, item) => s + Number(item.salary) + Number(item.bonus || 0), 0);
    $("confirmTotal").textContent = money(total) + " USDC";
  });
  $("confirmPayBtn").addEventListener("click", executePayroll);

  $("employeeTable").addEventListener("click", e => {
    const pay = e.target.closest("[data-pay]")?.dataset.pay;
    const edit = e.target.closest("[data-edit]")?.dataset.edit;
    const remove = e.target.closest("[data-remove]")?.dataset.remove;
    if (pay) payEmployee(employees.find(x => x.id === pay));
    if (edit) openEmployeeModal(employees.find(x => x.id === edit));
    if (remove) removeEmployee(remove);
  });

  if (window.ethereum) {
    window.ethereum.on?.("accountsChanged", async (accounts) => {
      if (!accounts.length) return $("disconnectBtn").click();
      account = ethers.getAddress(accounts[0]);
      $("walletAddress").textContent = shortAddr(account);
      provider = new ethers.BrowserProvider(window.ethereum);
      signer = await provider.getSigner();
      refreshBalance();
    });
    window.ethereum.on?.("chainChanged", () => window.location.reload());
  }

  updateNetworkUI();
  initHistoryMonths();
  renderEmployees();
})();
