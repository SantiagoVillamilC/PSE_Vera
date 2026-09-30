const query = new URLSearchParams(window.location.search);
const referencia = query.get('referencia') ?? '';
const monto = query.get('monto') ?? '';

Vue.createApp({
  data() { return { referencia, monto, estado: 'inicio', error: '', cus: '' }; },
  computed: {
    montoPresentado() {
      const cents = BigInt(this.monto);
      return `${(cents / 100n).toLocaleString('es-CO')},${String(cents % 100n).padStart(2, '0')}`;
    },
  },
  methods: {
    async resolver(accion) {
      if (this.estado !== 'inicio') return;
      this.estado = 'enviando';
      this.error = '';
      try {
        const response = await fetch(`/pse/${accion}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
          body: new URLSearchParams({ referencia: this.referencia, monto: this.monto }),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'No se pudo confirmar el pago. Intenta de nuevo.');
        this.cus = result.cus ?? '';
        this.estado = accion === 'autorizar' ? 'aprobado' : 'rechazado';
      } catch (cause) {
        this.error = cause.message || 'No hay conexión. Revisa tu red e intenta de nuevo.';
        this.estado = 'inicio';
      }
    },
  },
}).mount('#app');
