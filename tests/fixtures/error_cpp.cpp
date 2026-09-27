class Foo {
public:
    void bar(int x) {}
};

int main() {
    Foo f;
    f.bar("not_an_int");
    f.nonexistent();
    return 0;
}
