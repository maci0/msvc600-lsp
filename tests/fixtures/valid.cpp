class Counter {
public:
    Counter() : count_(0) {}
    void increment() { count_++; }
    int get() const { return count_; }
private:
    int count_;
};

int main() {
    Counter c;
    c.increment();
    c.increment();
    return c.get() == 2 ? 0 : 1;
}
